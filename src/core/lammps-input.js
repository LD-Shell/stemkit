/**
 * STEMKit, LAMMPS input scripts: reading, checking and explaining them.
 * Author: Olanrewaju M. Daramola
 *
 * @module core/lammps-input
 *
 * The reader follows LAMMPS's own rules (Input::file, Input::parse,
 * Input::substitute and Input::nextword in src/input.cpp, 29 Aug 2024):
 *
 *   - a physical line whose last printable character is `&` continues on the
 *     next one: the `&` and the line break go, nothing is put in their place;
 *   - an odd number of `"""` on the lines read so far keeps the command open,
 *     and the line breaks inside it are kept;
 *   - `#` starts a comment, except inside '', "" or """ quotes; a comment
 *     ending in `&` swallows the next line too;
 *   - `$x` (one character), `${name}` and `$(formula)` or `$(formula:%.3f)`
 *     are replaced before the line is split into words, except inside quotes;
 *     the replacement is not searched again for `$`;
 *   - words are separated by spaces, tabs and the other C white space; a
 *     word that starts with a quote runs to the matching quote, which must
 *     be followed by white space or the end of the line.
 *
 * `parseInput` does everything up to the substitution, which needs the
 * variables as they are when the line runs. `checkInput` then follows the
 * script the way LAMMPS executes it, top to bottom, loops and all, and
 * reports what LAMMPS would stop on (errors), what it warns about and what
 * helps (notes). `explainInput` says what each line does with its values.
 * `checkChain` and `explainChain` do the same for the inputs of a workflow,
 * carrying what each restart file holds into the stage that reads it.
 *
 * The argument tables (SPECS, PAIR_INFO and friends) record, for the common
 * commands and styles, what LAMMPS reads and the message it stops with; they
 * were written from the LAMMPS source and checked against a real build.
 * tools/check-lammps.mjs compares this checker with lmp on the LAMMPS
 * examples and on deliberate mistakes made in them.
 *
 * ```js
 * const { issues, firstError } = checkInput(text, { packages: ['MOLECULE', 'KSPACE'] });
 * explainInput(text)[5].meaning; // 'Each step is 2.0 fs (real units).'
 * ```
 */

export * from './lammps-reference.js';
import { UNITS, lammpsDocUrl, commandInfo, styleExists, listCommands } from './lammps-reference.js';

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/* C's isspace, which LAMMPS uses to trim lines and split words. */
const SPACE = ' \t\n\v\f\r';
const isSpace = (c) => c !== '' && SPACE.includes(c);

/*
 * Characters LAMMPS replaces before it reads a line (utils::utf8_subst), so a
 * script pasted from a web page or a word processor still works. Any other
 * non-ASCII character is garbled: its first byte is dropped.
 */
const UTF8_SUBST = new Map([
  [' ', ' '], ['˖', '+'], ['˗', '-'], [' ', ' '], [' ', ' '], [' ', ' '],
  [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '],
  [' ', ' '], [' ', ' '], ['​', ' '], ['‘', "'"], ['’', "'"], ['“', '"'],
  ['”', '"'], [' ', ' '], ['⁠', ' '], ['⁣', ' '], ['⁤', '+'], ['−', '-'],
  ['﻿', ' ']
]);

/**
 * Replace the non-ASCII look-alikes LAMMPS replaces.
 *
 * @param {string} s
 * @returns {{text:string, replaced:string[], garbled:string[]}}
 */
function asciiSubst(s) {
  let text = '';
  const replaced = [];
  const garbled = [];
  for (const ch of s) {
    if (ch.charCodeAt(0) < 128) { text += ch; continue; }
    const r = UTF8_SUBST.get(ch);
    if (r !== undefined) { text += r; replaced.push(ch); } else { garbled.push(ch); }
  }
  return { text, replaced, garbled };
}

/*
 * Find the end of the quote that starts at s[i]: the index just past the
 * closing quote, or -1 when it is not closed. Used where LAMMPS skips quoted
 * text (comments, substitution): a quote anywhere counts, even mid-word.
 */
function skipQuote(s, i) {
  if (s.startsWith('"""', i)) {
    const j = s.indexOf('"""', i + 3);
    return j < 0 ? -1 : j + 3;
  }
  const j = s.indexOf(s[i], i + 1);
  return j < 0 ? -1 : j + 1;
}

const QUOTE_ERROR = { "'": 'Unmatched single quote in command', '"': 'Unmatched double quote in command', '"""': 'Unmatched triple quote in command' };

/**
 * Cut the comment off a logical line, as Input::parse does.
 *
 * @param {string} text
 * @returns {{code:string, comment:string, error:string|null}}
 */
export function stripComment(text) {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') return { code: text.slice(0, i), comment: text.slice(i + 1).trim(), hasComment: true, error: null };
    if (c === "'" || c === '"') {
      const j = skipQuote(text, i);
      if (j < 0) return { code: text, comment: '', hasComment: false, error: QUOTE_ERROR[text.startsWith('"""', i) ? '"""' : c] };
      i = j;
    } else i += 1;
  }
  return { code: text, comment: '', hasComment: false, error: null };
}

/**
 * Split a line into words, as Input::nextword does. Quotes are only special
 * at the start of a word; they are removed.
 *
 * @param {string} s
 * @returns {{words:string[], quoted:boolean[], error:string|null}}
 */
export function splitWords(s) {
  const words = [];
  const quoted = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && isSpace(s[i])) i += 1;
    if (i >= n) break;
    let word;
    let q = false;
    if (s.startsWith('"""', i) || s[i] === '"' || s[i] === "'") {
      const triple = s.startsWith('"""', i);
      const open = triple ? '"""' : s[i];
      const stop = s.indexOf(open, i + open.length);
      if (stop < 0) return { words, quoted, error: 'Unbalanced quotes in input line' };
      word = s.slice(i + open.length, stop);
      i = stop + open.length;
      if (i < n && !isSpace(s[i])) return { words, quoted, error: 'Input line quote not followed by white-space' };
      q = true;
    } else {
      let j = i;
      while (j < n && !isSpace(s[j])) j += 1;
      word = s.slice(i, j);
      i = j;
    }
    words.push(word);
    quoted.push(q);
  }
  return { words, quoted, error: null };
}

/**
 * Where `$` substitutions sit in a line (outside quotes), without replacing
 * them: `{start, end, kind:'char'|'name'|'immediate', name, format}`.
 *
 * @param {string} code - A line with its comment removed.
 * @returns {{refs:Array<object>, error:string|null}}
 */
export function findSubstitutions(code) {
  const refs = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '$') {
      const next = code[i + 1];
      if (next === '{') {
        const close = code.indexOf('}', i + 2);
        if (close < 0) return { refs, error: 'Invalid variable name' };
        refs.push({ start: i, end: close + 1, kind: 'name', name: code.slice(i + 2, close) });
        i = close + 1;
      } else if (next === '(') {
        let depth = 0;
        let j = i + 2;
        while (j < code.length && (code[j] !== ')' || depth !== 0)) {
          if (code[j] === '(') depth += 1;
          else if (code[j] === ')') depth -= 1;
          j += 1;
        }
        if (j >= code.length) return { refs, error: 'Invalid immediate variable' };
        let expr = code.slice(i + 2, j);
        let format = '%.20g';
        const colon = expr.lastIndexOf(':');
        if (colon >= 0 && expr[colon + 1] === '%') { format = expr.slice(colon + 1); expr = expr.slice(0, colon); }
        refs.push({ start: i, end: j + 1, kind: 'immediate', name: expr, format });
        i = j + 1;
      } else {
        // `$x` is the one character after the $ (at the end of the line,
        // the empty name, which no variable has).
        refs.push({ start: i, end: Math.min(i + 2, code.length), kind: 'char', name: next === undefined ? '' : next });
        i += 2;
      }
    } else if (c === "'" || c === '"') {
      const j = skipQuote(code, i);
      if (j < 0) return { refs, error: QUOTE_ERROR[code.startsWith('"""', i) ? '"""' : c] };
      i = j;
    } else i += 1;
  }
  return { refs, error: null };
}

/**
 * @typedef {object} LammpsLine
 * @property {number} line - First physical line, counted from 1.
 * @property {number} lastLine - Last physical line of the command.
 * @property {string} raw - The physical lines as written, joined by line feeds.
 * @property {string} text - The command as LAMMPS reads it: continuation
 *   lines joined (`&` and line breaks removed), before comments are cut.
 * @property {string} code - `text` without its comment.
 * @property {'command'|'comment'|'blank'} kind
 * @property {string} command - The first word ('' when there is none).
 * @property {string[]} args - The other words, quotes removed, `$` not yet
 *   replaced (which may change the words: see `hasVars`).
 * @property {boolean[]} quoted - Which args were quoted.
 * @property {string} comment - Text after `#`, trimmed.
 * @property {boolean} hasVars - The line has `$` substitutions outside quotes.
 */

/**
 * Read an input script as LAMMPS reads it.
 *
 * @param {string} text
 * @returns {{lines:LammpsLine[], errors:Array<{line:number, lastLine:number, id:string, message:string}>}}
 */
export function parseInput(text) {
  const src = String(text == null ? '' : text);
  const physical = src.split('\n');
  const endsWithNewline = src.endsWith('\n');
  if (endsWithNewline) physical.pop();
  const lines = [];
  const errors = [];
  let i = 0;
  while (i < physical.length) {
    const first = i;
    let joined = '';
    let triples = 0;
    const rawParts = [];
    for (;;) {
      const p = physical[i];
      rawParts.push(p);
      const lastPhysical = i === physical.length - 1;
      i += 1;
      // The last line of a file without a final line break is taken as it
      // is: LAMMPS reaches the end of the file before it can look for & or """.
      if (lastPhysical && !endsWithNewline) { joined += p; break; }
      triples += (p.match(/"""/g) || []).length;
      let end = p.length;
      while (end > 0 && isSpace(p[end - 1])) end -= 1;
      const trimmed = p.slice(0, end);
      if (trimmed.endsWith('&')) {
        if (i >= physical.length) {
          // Nothing follows: the & stays part of the command.
          joined += `${p}\n`;
          break;
        }
        joined += trimmed.slice(0, -1);
        continue;
      }
      if (triples % 2) {
        joined += `${trimmed}\n`;
        if (i >= physical.length) break;
        continue;
      }
      joined += trimmed;
      break;
    }
    const entry = parseLogical(joined, first + 1, first + rawParts.length, rawParts.join('\n'), errors);
    lines.push(entry);
  }
  return { lines, errors };
}

function parseLogical(text, line, lastLine, raw, errors) {
  const entry = { line, lastLine, raw, text, code: '', kind: 'blank', command: '', args: [], quoted: [], comment: '', hasVars: false };
  const cut = stripComment(text);
  entry.code = cut.code;
  entry.comment = cut.comment;
  if (cut.error) {
    errors.push({ line, lastLine, id: 'quote', message: `${cut.error}: a quote is opened and never closed, so LAMMPS stops.` });
    entry.kind = 'command';
    entry.error = cut.error;
    const w = cut.code.trim().split(/\s+/);
    entry.command = w[0] || '';
    entry.args = w.slice(1);
    entry.quoted = entry.args.map(() => false);
    return entry;
  }
  const subs = findSubstitutions(cut.code);
  entry.hasVars = subs.refs.length > 0;
  const split = splitWords(cut.code);
  if (!split.words.length) {
    entry.kind = cut.hasComment ? 'comment' : 'blank';
    return entry;
  }
  entry.kind = 'command';
  entry.command = split.words[0];
  entry.args = split.words.slice(1);
  entry.quoted = split.quoted.slice(1);
  if (subs.error) {
    entry.error = subs.error;
    errors.push({ line, lastLine, id: 'substitution', message: `${subs.error}: a \${ or $( is never closed, so LAMMPS stops.` });
  } else if (split.error && !entry.hasVars) {
    // With $ in the line the words may change once the values are in.
    entry.error = split.error;
    errors.push({ line, lastLine, id: 'quote', message: `${split.error}.` });
  }
  return entry;
}

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

/*
 * A value that only the run can give (a thermo quantity, a file, the
 * environment) is carried through substitution as this mark, so a word that
 * contains it is known to be "something" without being checked.
 */
const UNKNOWN = '\u0001';
const isUnknown = (w) => typeof w === 'string' && w.includes(UNKNOWN);

/* utils::is_double and utils::is_integer: what LAMMPS accepts as numbers. */
const DOUBLE_RE = /^[+-]?(\d+\.?\d*|\d*\.?\d+)([eE][+-]?\d+)?$/;
export const isLammpsNumber = (s) => DOUBLE_RE.test(String(s));
export const isLammpsInteger = (s) => /^[+-]?\d+$/.test(String(s));
/* utils::is_id: letters, digits and underscores. */
const isId = (s) => /^[A-Za-z0-9_]+$/.test(String(s));
const BOOL_WORDS = new Set(['yes', 'no', 'on', 'off', 'true', 'false', '1', '0']);

/**
 * C's printf for one double: %[flags][width][.precision](e|f|g|E|F|G).
 *
 * @param {string} spec - e.g. '%.20g', '%10.3f'
 * @param {number} x
 * @returns {string}
 */
export function formatC(spec, x) {
  const m = /^%([-+ 0#]*)(\d*)(?:\.(\d*))?([eEfFgG])$/.exec(spec);
  if (!m) return String(x);
  const [, flags, width, precText, conv] = m;
  const prec = precText === undefined ? 6 : Number(precText || 0);
  let body;
  if (!Number.isFinite(x)) body = Number.isNaN(x) ? 'nan' : (x < 0 ? '-inf' : 'inf');
  else {
    const lower = conv.toLowerCase();
    const abs = Math.abs(x);
    if (lower === 'f') body = abs.toFixed(Math.min(prec, 100));
    else if (lower === 'e') body = expC(abs, prec);
    else {
      const p = prec === 0 ? 1 : prec;
      if (abs === 0) body = flags.includes('#') ? (0).toFixed(p - 1) : '0';
      else {
        const exp = Number(abs.toExponential(Math.min(p - 1, 100)).split('e')[1]);
        body = exp < -4 || exp >= p ? expC(abs, p - 1) : abs.toFixed(Math.min(Math.max(p - 1 - exp, 0), 100));
        if (!flags.includes('#')) {
          body = body.replace(/(\.\d*?)0+(e|$)/, '$1$2').replace(/\.(e|$)/, '$1');
        }
      }
    }
    if (conv === conv.toUpperCase()) body = body.toUpperCase();
    if (x < 0 || Object.is(x, -0)) body = `-${body}`;
    else if (flags.includes('+')) body = `+${body}`;
    else if (flags.includes(' ')) body = ` ${body}`;
  }
  const w = Number(width || 0);
  if (body.length < w) {
    if (flags.includes('-')) body = body.padEnd(w);
    else if (flags.includes('0') && /^[-+ ]?\d/.test(body)) {
      const sign = /^[-+ ]/.test(body) ? body[0] : '';
      body = sign + body.slice(sign.length).padStart(w - sign.length, '0');
    } else body = body.padStart(w);
  }
  return body;
}

function expC(abs, prec) {
  const [mant, e] = abs.toExponential(Math.min(prec, 100)).split('e');
  const n = Number(e);
  return `${mant}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
}

/*
 * $(formula:format): LAMMPS checks only that the format contains a
 * conversion like %.3f somewhere, then prints with the whole format, so
 * "%.3f nm" gives "0.333 nm".
 */
function formatImmediate(fmt, x) {
  const m = /%[-+ 0#]*\d*(?:\.\d*)?[efgEFG]/.exec(fmt);
  if (!m) return String(x);
  return (fmt.slice(0, m.index) + formatC(m[0], x) + fmt.slice(m.index + m[0].length)).replace(/%%/g, '%');
}

/* How LAMMPS turns an equal-style result into text for ${name}: {:.15g}. */
const fmtVar = (x) => formatC('%.15g', Math.abs(x) < 2.2250738585072014e-308 ? 0 : x);

/* ------------------------------------------------------------------ *
 * Formulas (equal-, vector- and atom-style variables, $(...))
 * ------------------------------------------------------------------ */

const PRECEDENCE = { '||': 1, '|^': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 7, neg: 8, '!': 8 };

const FORMULA_CONSTANTS = { PI: Math.PI, version: 20240829, yes: 1, no: 0, on: 1, off: 0, true: 1, false: 0 };

/* name -> allowed argument counts. */
const MATH_FUNCTIONS = {
  sqrt: [1], exp: [1], ln: [1], log: [1], abs: [1], sin: [1], cos: [1], tan: [1], asin: [1], acos: [1], atan: [1],
  atan2: [2], random: [3], normal: [3], ceil: [1], floor: [1], round: [1], sign: [1], ternary: [3], ramp: [2],
  stagger: [2], logfreq: [3], logfreq2: [3], logfreq3: [3], stride: [3], stride2: [6], vdisplace: [2], swiggle: [3], cwiggle: [3]
};
const GROUP_FUNCTIONS = {
  count: [1, 2], mass: [1, 2], charge: [1, 2], xcm: [2, 3], vcm: [2, 3], fcm: [2, 3], bound: [2, 3], gyration: [1, 2],
  ke: [1, 2], angmom: [2, 3], torque: [2, 3], inertia: [2, 3], omega: [2, 3]
};
const VECTOR_FUNCTIONS = new Set(['sum', 'min', 'max', 'ave', 'trap', 'slope', 'sort', 'rsort']);
const OTHER_SPECIAL = new Set(['gmask', 'rmask', 'grmask', 'next', 'is_file', 'is_os', 'extract_setting', 'label2type', 'is_typelabel', 'is_timeout']);
const FEATURE_FUNCTIONS = new Set(['is_active', 'is_available', 'is_defined']);
const ATOM_VECTORS = new Set(['id', 'mass', 'type', 'mol', 'radius', 'q', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'fx', 'fy', 'fz']);

/* Thermo keywords a formula may use, and the thermo compute each needs. */
const THERMO_WORDS = new Set(('step elapsed elaplong dt time cpu tpcpu spcpu cpuremain part timeremain atoms temp press pe ke ' +
  'etotal evdwl ecoul epair ebond eangle edihed eimp emol elong etail enthalpy ecouple econserve vol density lx ly lz xlo ' +
  'xhi ylo yhi zlo zhi xy xz yz avecx avecy avecz bvecx bvecy bvecz cvecx cvecy cvecz xlat ylat zlat cella cellb cellc ' +
  'cellalpha cellbeta cellgamma pxx pyy pzz pxy pxz pyz bonds angles dihedrals impropers fmax fnorm nbuild ndanger').split(' '));
const THERMO_NEEDS = {
  temp: 'temp', ke: 'temp', press: 'press', pxx: 'press', pyy: 'press', pzz: 'press', pxy: 'press', pxz: 'press', pyz: 'press',
  pe: 'pe', evdwl: 'pe', ecoul: 'pe', epair: 'pe', ebond: 'pe', eangle: 'pe', edihed: 'pe', eimp: 'pe', emol: 'pe', elong: 'pe',
  etail: 'pe', etotal: 'pe temp', enthalpy: 'pe temp press', econserve: 'pe temp'
};
/* Thermo keywords a formula can use only while a run is going on. */
const THERMO_DURING_RUN = new Set(['elapsed', 'elaplong', 'cpu', 'tpcpu', 'spcpu', 'cpuremain']);
/* What each thermo_style keyword makes thermo compute (and so allows in formulas). */
const THERMO_STYLE_COMPUTES = {
  temp: ['temp'], ke: ['temp'], etotal: ['temp', 'pe'], press: ['press'], pe: ['pe'], evdwl: ['pe'], ecoul: ['pe'], epair: ['pe'],
  ebond: ['pe'], eangle: ['pe'], edihed: ['pe'], eimp: ['pe'], emol: ['pe'], elong: ['pe'], etail: ['pe'],
  enthalpy: ['temp', 'press', 'pe'], ecouple: ['pe'], econserve: ['temp', 'pe'],
  pxx: ['press'], pyy: ['press'], pzz: ['press'], pxy: ['press'], pxz: ['press'], pyz: ['press']
};

/*
 * Read a formula into a tree, with LAMMPS's precedence (a shunting yard in
 * which every operator, even ^, is left associative, and unary minus binds
 * tighter than ^, so -2^2 is 4).
 */
function lexFormula(str) {
  const toks = [];
  let i = 0;
  const n = str.length;
  while (i < n) {
    const c = str[i];
    if (isSpace(c)) { i += 1; continue; }
    if (c === UNKNOWN) { toks.push({ t: 'unknown' }); i += 1; continue; }
    if (c === '(') {
      const j = matchParen(str, i);
      if (j < 0) throw new FormulaError('Invalid syntax in variable formula', 'unbalanced');
      toks.push({ t: 'paren', text: str.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9.]*([eE][+-]?\d*)?/.exec(str.slice(i));
      toks.push({ t: 'num', text: m[0], value: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z0-9_]+/.exec(str.slice(i));
      const word = m[0];
      i += word.length;
      if (str[i] === '(') {
        const j = matchParen(str, i);
        if (j < 0) throw new FormulaError('Invalid syntax in variable formula', 'unbalanced');
        toks.push({ t: 'func', word, text: str.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      const idx = [];
      while (str[i] === '[') {
        const j = str.indexOf(']', i);
        if (j < 0) throw new FormulaError('Invalid syntax in variable formula', 'bracket');
        idx.push(str.slice(i + 1, j));
        i = j + 1;
      }
      toks.push({ t: 'word', word, idx });
      continue;
    }
    const two = str.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '|^'].includes(two)) { toks.push({ t: 'op', op: two }); i += 2; continue; }
    if ('+-*/%^<>!'.includes(c)) { toks.push({ t: 'op', op: c }); i += 1; continue; }
    throw new FormulaError('Invalid syntax in variable formula', `character ${c}`);
  }
  return toks;
}

function matchParen(str, i) {
  let depth = 0;
  for (let j = i; j < str.length; j++) {
    if (str[j] === '(') depth += 1;
    else if (str[j] === ')') { depth -= 1; if (depth === 0) return j; }
  }
  return -1;
}

class FormulaError extends Error {
  constructor(message, detail = '') { super(message); this.detail = detail; }
}

/* Split function arguments at top-level commas. */
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out.length === 1 && out[0] === '' ? [] : out;
}

/**
 * Evaluate a formula as far as the script alone allows.
 *
 * @param {string} text
 * @param {object} env - {lookup(kind, name) for references, style: 'equal'|'atom'|'vector'}
 * @returns {number|null} null when the value depends on the run.
 */
function evalFormula(text, env) {
  const toks = lexFormula(text);
  const out = [];
  const ops = [];
  let expect = 'arg';
  const apply = (op) => {
    if (op === 'neg' || op === '!') {
      const a = out.pop();
      if (a === undefined) throw new FormulaError('Invalid syntax in variable formula', 'operand');
      out.push(a === null ? null : op === 'neg' ? -a : (a === 0 ? 1 : 0));
      return;
    }
    const b = out.pop();
    const a = out.pop();
    if (a === undefined || b === undefined) throw new FormulaError('Invalid syntax in variable formula', 'operand');
    if (a === null || b === null) {
      if ((op === '/' || op === '%') && b === 0) throw new FormulaError(op === '/' ? 'Divide by 0 in variable formula' : 'Modulo 0 in variable formula');
      out.push(null);
      return;
    }
    let v;
    switch (op) {
      case '+': v = a + b; break;
      case '-': v = a - b; break;
      case '*': v = a * b; break;
      case '/': if (b === 0) throw new FormulaError('Divide by 0 in variable formula'); v = a / b; break;
      case '%': if (b === 0) throw new FormulaError('Modulo 0 in variable formula'); v = a % b; break;
      case '^': if (b === 0) v = 1; else if (a === 0 && b < 0) throw new FormulaError('Invalid power expression in variable formula'); else v = a ** b; break;
      case '==': v = a === b ? 1 : 0; break;
      case '!=': v = a !== b ? 1 : 0; break;
      case '<': v = a < b ? 1 : 0; break;
      case '<=': v = a <= b ? 1 : 0; break;
      case '>': v = a > b ? 1 : 0; break;
      case '>=': v = a >= b ? 1 : 0; break;
      case '&&': v = a !== 0 && b !== 0 ? 1 : 0; break;
      case '||': v = a !== 0 || b !== 0 ? 1 : 0; break;
      case '|^': v = (a === 0) !== (b === 0) ? 1 : 0; break;
      default: v = null;
    }
    out.push(v);
  };
  for (const tok of toks) {
    if (tok.t === 'op') {
      let op = tok.op;
      if (expect === 'arg') {
        if (op === '-') { ops.push('neg'); continue; }
        if (op === '!') { ops.push('!'); continue; }
        throw new FormulaError('Invalid syntax in variable formula', `operator ${op}`);
      }
      if (op === '!') throw new FormulaError('Invalid syntax in variable formula', 'operator !');
      while (ops.length && PRECEDENCE[ops[ops.length - 1]] >= PRECEDENCE[op]) apply(ops.pop());
      ops.push(op);
      expect = 'arg';
      continue;
    }
    if (expect === 'op') throw new FormulaError('Invalid syntax in variable formula', 'missing operator');
    expect = 'op';
    if (tok.t === 'num') out.push(tok.value);
    else if (tok.t === 'unknown') out.push(null);
    else if (tok.t === 'paren') out.push(evalFormula(tok.text, env));
    else if (tok.t === 'func') out.push(evalFunction(tok, env));
    else out.push(evalWord(tok, env));
  }
  if (expect === 'arg' && (toks.length || ops.length)) throw new FormulaError('Invalid syntax in variable formula', 'trailing operator');
  while (ops.length) apply(ops.pop());
  if (out.length !== 1) throw new FormulaError('Invalid syntax in variable formula', 'empty');
  return out[0];
}

function evalFunction(tok, env) {
  const { word } = tok;
  const args = splitArgs(tok.text);
  if (MATH_FUNCTIONS[word]) {
    if (!MATH_FUNCTIONS[word].includes(args.length)) throw new FormulaError('Invalid math function in variable formula', word);
    const v = args.map(a => evalFormula(a, env));
    if (v.some(x => x === null)) return null;
    const [a, b, c] = v;
    switch (word) {
      case 'sqrt': if (a < 0) throw new FormulaError('Sqrt of negative value in variable formula'); return Math.sqrt(a);
      case 'exp': return Math.exp(a);
      case 'ln': if (a <= 0) throw new FormulaError('Log of zero/negative value in variable formula'); return Math.log(a);
      case 'log': if (a <= 0) throw new FormulaError('Log of zero/negative value in variable formula'); return Math.log10(a);
      case 'abs': return Math.abs(a);
      case 'sin': return Math.sin(a);
      case 'cos': return Math.cos(a);
      case 'tan': return Math.tan(a);
      case 'asin': if (a < -1 || a > 1) throw new FormulaError('Arcsin of invalid value in variable formula'); return Math.asin(a);
      case 'acos': if (a < -1 || a > 1) throw new FormulaError('Arccos of invalid value in variable formula'); return Math.acos(a);
      case 'atan': return Math.atan(a);
      case 'atan2': return Math.atan2(a, b);
      case 'ceil': return Math.ceil(a);
      case 'floor': return Math.floor(a);
      case 'round': return a < 0 ? -Math.round(-a) : Math.round(a);
      case 'sign': return a >= 0 ? 1 : -1;
      case 'ternary': return a !== 0 ? b : c;
      default: return null; // random numbers and functions of the step
    }
  }
  if (GROUP_FUNCTIONS[word]) {
    if (!GROUP_FUNCTIONS[word].includes(args.length)) throw new FormulaError('Invalid group function in variable formula', word);
    env.lookup('group', args[0]);
    if (word === 'charge') env.lookup('charges');
    if ((word === 'count' || word === 'mass' || word === 'charge' || word === 'gyration' || word === 'ke') && args[1]) env.lookup('region', args[1]);
    if (args.length === 3) env.lookup('region', args[2]);
    return null;
  }
  if (VECTOR_FUNCTIONS.has(word)) {
    if (args.length !== 1) throw new FormulaError(`Invalid special function ${word}() in variable formula`);
    const m = /^([cfv])_([A-Za-z0-9_]+)/.exec(args[0]);
    if (!m) throw new FormulaError('Invalid special function in variable formula');
    env.lookup({ c: 'compute', f: 'fix', v: 'variable' }[m[1]], m[2]);
    return null;
  }
  if (word === 'gmask' || word === 'rmask' || word === 'grmask') {
    if (word !== 'rmask') env.lookup('group', args[0]);
    if (word !== 'gmask') env.lookup('region', args[word === 'rmask' ? 0 : 1]);
    return null;
  }
  if (OTHER_SPECIAL.has(word) || FEATURE_FUNCTIONS.has(word)) {
    if (word === 'next') env.lookup('variable', args[0]);
    return null;
  }
  throw new FormulaError(`Invalid math/group/special/feature function '${word}()' in variable formula`, word);
}

function evalWord(tok, env) {
  const { word, idx } = tok;
  const m = /^([cCfFv])_(.+)$/.exec(word);
  if (m) {
    const kind = { c: 'compute', C: 'compute', f: 'fix', F: 'fix', v: 'variable' }[m[1]];
    return env.lookup(kind, m[2], idx);
  }
  if (/^[id]2?_/.test(word)) return null; // custom per-atom properties
  if (idx.length) {
    if (ATOM_VECTORS.has(word)) { env.lookup('box'); return null; }
    throw new FormulaError(`Invalid atom value ${word}[] in variable formula`);
  }
  if (ATOM_VECTORS.has(word)) {
    env.lookup('box');
    if (env.style === 'equal') throw new FormulaError('Atom vector in equal-style variable formula');
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(FORMULA_CONSTANTS, word)) return FORMULA_CONSTANTS[word];
  env.lookup('box');
  if (!THERMO_WORDS.has(word)) throw new FormulaError(`Invalid thermo keyword '${word}' in variable formula`);
  return env.lookup('thermo', word);
}

/*
 * The Boolean of `if` (Variable::evaluate_boolean): numbers and bare words
 * (compared as strings with == and !=), comparisons and logic, no arithmetic.
 * Returns true/false, or null when a value is not known.
 */
function evalBoolean(str) {
  const toks = [];
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (isSpace(c)) { i += 1; continue; }
    if (c === UNKNOWN) { toks.push({ t: 'arg', v: null }); i += 1; continue; }
    if (c === '(') {
      const j = matchParen(str, i);
      if (j < 0) throw new FormulaError('Invalid Boolean syntax in if command');
      const v = evalBoolean(str.slice(i + 1, j));
      toks.push({ t: 'arg', v: v === null ? null : v ? 1 : 0 });
      i = j + 1;
      continue;
    }
    if (/[0-9.\-]/.test(c)) {
      const m = /^-?[0-9.]*([eE][+-]?\d*)?/.exec(str.slice(i));
      toks.push({ t: 'arg', v: parseFloat(m[0]) });
      i += Math.max(m[0].length, 1);
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z0-9_/]+/.exec(str.slice(i));
      toks.push({ t: 'arg', s: m[0] });
      i += m[0].length;
      continue;
    }
    const two = str.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '|^'].includes(two)) { toks.push({ t: 'op', op: two }); i += 2; continue; }
    if ('<>!'.includes(c)) { toks.push({ t: 'op', op: c }); i += 1; continue; }
    throw new FormulaError('Invalid Boolean syntax in if command');
  }
  const out = [];
  const ops = [];
  let expect = 'arg';
  const apply = (op) => {
    if (op === '!') {
      const a = out.pop();
      if (!a) throw new FormulaError('Invalid Boolean syntax in if command');
      if (a.s !== undefined) throw new FormulaError('If command boolean not cannot operate on string');
      out.push({ v: a.v === null ? null : a.v === 0 ? 1 : 0 });
      return;
    }
    const b = out.pop();
    const a = out.pop();
    if (!a || !b) throw new FormulaError('Invalid Boolean syntax in if command');
    const strA = a.s !== undefined;
    const strB = b.s !== undefined;
    if (op === '==' || op === '!=') {
      if (strA !== strB) throw new FormulaError('If command boolean is comparing string to number');
      if (strA) { out.push({ v: (a.s === b.s) === (op === '==') ? 1 : 0 }); return; }
    } else if (strA || strB) throw new FormulaError('If command boolean can only operate on numbers');
    if (a.v === null || b.v === null) { out.push({ v: null }); return; }
    const x = a.v;
    const y = b.v;
    const r = { '==': x === y, '!=': x !== y, '<': x < y, '<=': x <= y, '>': x > y, '>=': x >= y,
      '&&': x !== 0 && y !== 0, '||': x !== 0 || y !== 0, '|^': (x === 0) !== (y === 0) }[op];
    out.push({ v: r ? 1 : 0 });
  };
  for (const tok of toks) {
    if (tok.t === 'op') {
      if (tok.op === '!' && expect === 'arg') { ops.push('!'); continue; }
      if (expect === 'arg') throw new FormulaError('Invalid Boolean syntax in if command');
      while (ops.length && PRECEDENCE[ops[ops.length - 1]] >= PRECEDENCE[tok.op]) apply(ops.pop());
      ops.push(tok.op);
      expect = 'arg';
    } else {
      if (expect === 'op') throw new FormulaError('Invalid Boolean syntax in if command');
      out.push(tok);
      expect = 'op';
    }
  }
  if (expect === 'arg') throw new FormulaError('Invalid Boolean syntax in if command');
  while (ops.length) apply(ops.pop());
  if (out.length !== 1) throw new FormulaError('Invalid Boolean syntax in if command');
  const r = out[0];
  if (r.s !== undefined) throw new FormulaError('If command boolean can only operate on numbers');
  return r.v === null ? null : r.v !== 0;
}

/* ------------------------------------------------------------------ *
 * Checking: following the script as LAMMPS runs it
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} LammpsIssue
 * @property {number} line - The line LAMMPS stops on (for an error) or the
 *   line the issue is about.
 * @property {number} [lastLine] - Last physical line of that command.
 * @property {'error'|'warning'|'note'} severity - error: LAMMPS stops there;
 *   warning: LAMMPS warns, or the run will very likely go wrong; note: advice.
 * @property {string} id - Stable code for the check, e.g. `unknown-command`.
 * @property {string} message - Plain words: what LAMMPS does and how to fix it.
 * @property {string} url - The docs.lammps.org page that explains it.
 * @property {string} [lammps] - The message LAMMPS itself prints, when it prints one.
 * @property {number[]} [related] - Other lines involved (where the cause is).
 */

const DOCS = 'https://docs.lammps.org/';
/* Passes through one jump loop that are followed before STEMKit moves on. */
const LOOP_LIMIT = 500;
const page = (p) => `${DOCS}${p}.html`;
const DEFAULT_UNITS = 'lj';

/* Commands LAMMPS implements in input.cpp itself, whatever the table says. */
const META = new Set(['clear', 'echo', 'if', 'include', 'jump', 'label', 'log', 'next', 'partition', 'print', 'python', 'quit', 'shell', 'variable']);

/* Commands that must come before the box exists, with LAMMPS's message. */
const BEFORE_BOX = {
  units: 'Units command after simulation box is defined',
  atom_style: 'Atom_style command after simulation box is defined',
  dimension: 'Dimension command after simulation box is defined',
  boundary: 'Boundary command after simulation box is defined',
  processors: 'Processors command after simulation box is defined',
  package: 'Package command after simulation box is defined'
};

/* Commands that need the box, with LAMMPS's message. */
const NEEDS_BOX = {
  mass: 'Mass command before simulation box is defined',
  pair_coeff: 'Pair_coeff command before simulation box is defined',
  bond_coeff: 'Bond_coeff command before simulation box is defined',
  angle_coeff: 'Angle_coeff command before simulation box is defined',
  dihedral_coeff: 'Dihedral_coeff command before simulation box is defined',
  improper_coeff: 'Improper_coeff command before simulation box is defined',
  group: 'Group command before simulation box is defined',
  velocity: 'Velocity command before simulation box is defined',
  fix: 'Fix command before simulation box is defined',
  displace_atoms: 'Displace_atoms command before simulation box is defined',
  create_atoms: 'Create_atoms command before simulation box is defined',
  delete_atoms: 'Delete_atoms command before simulation box is defined',
  delete_bonds: 'Delete_bonds command before simulation box is defined',
  create_bonds: 'Create_bonds command before simulation box is defined',
  set: 'Set command before simulation box is defined',
  replicate: 'Replicate command before simulation box is defined',
  write_data: 'Write_data command before simulation box is defined',
  write_restart: 'Write_restart command before simulation box is defined',
  write_dump: 'Write_dump command before simulation box is defined',
  write_coeff: 'Write_coeff command before simulation box is defined',
  run: 'Run command before simulation box is defined',
  minimize: 'Minimize command before simulation box is defined',
  rerun: 'Rerun command before simulation box is defined',
  balance: 'Balance command before simulation box is defined',
  min_style: 'Min_style command before simulation box is defined',
  run_style: 'Run_style command before simulation box is defined',
  labelmap: 'Labelmap command before simulation box is defined',
  thermo_style: 'Thermo_style command before simulation box is defined',
  change_box: 'Change_box command before simulation box is defined',
  read_dump: 'Read_dump command before simulation box is defined',
  angle_write: 'Angle_write command before simulation box is defined',
  dihedral_write: 'Dihedral_write command before simulation box is defined',
  reset_atoms: null
};

/* Fixes LAMMPS lets you define before the box (modify.cpp). */
const FIX_BEFORE_BOX = new Set(['GPU', 'OMP', 'INTEL', 'property/atom', 'cmap', 'cmap3', 'rx', 'deprecated', 'STORE/KIM', 'amoeba/pitorsion', 'amoeba/bitorsion']);

/*
 * What the atom styles of the LAMMPS core and MOLECULE package hold
 * (checked against a real build). Any other style is taken to hold
 * everything, so nothing is reported that only a missing property would cause.
 */
const ATOM_STYLES = {
  atomic: {}, charge: { q: true }, bond: { mol: true, bonds: true }, angle: { mol: true, bonds: true, angles: true },
  molecular: { mol: true, bonds: true, angles: true, dihedrals: true, impropers: true },
  full: { q: true, mol: true, bonds: true, angles: true, dihedrals: true, impropers: true },
  sphere: { radius: true }, ellipsoid: {}, line: { mol: true, radius: true }, tri: { mol: true, radius: true }, body: { radius: true },
  template: { mol: true, bonds: true, angles: true, dihedrals: true, impropers: true, template: true }
};
const ALL_PROPS = { q: true, mol: true, bonds: true, angles: true, dihedrals: true, impropers: true, radius: true, mu: true };
const propsOf = (style) => ({ ...(ATOM_STYLES[style] || ALL_PROPS) });

/* Edit distance, for "did you mean". */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const nearCache = new Map();
function namesOfKind(kind) {
  if (!nearCache.has(kind)) {
    const names = [];
    for (const info of listCommandsSafe(kind)) if (info.exists !== false && !info.removed) names.push(info.kind === 'command' ? info.command : info.style);
    if (kind === 'command') for (const m of META) names.push(m);
    nearCache.set(kind, names);
  }
  return nearCache.get(kind);
}

function listCommandsSafe(kind) {
  try { return listCommands({ kind }); } catch { return []; }
}

/* The closest known name of a kind, or ''. */
function didYouMean(word, kind) {
  const w = String(word);
  if (!w || w.length < 2) return '';
  let best = '';
  let score = Infinity;
  for (const name of namesOfKind(kind)) {
    const d = editDistance(w, name);
    if (d < score || (d === score && name.length < best.length)) { score = d; best = name; }
  }
  const limit = w.length <= 4 ? 1 : w.length <= 8 ? 2 : 3;
  return score <= limit ? best : '';
}

const PLURAL = (n, s, p = `${s}s`) => `${n} ${n === 1 ? s : p}`;
const fmtNum = (x) => {
  if (!Number.isFinite(x)) return String(x);
  const r = Number(x.toPrecision(6));
  return Math.abs(r) >= 1e6 || (Math.abs(r) < 1e-3 && r !== 0) ? r.toExponential().replace('e+', 'e') : String(r);
};

/* A stop: LAMMPS ends the script here. */
class Stop extends Error {}

class Machine {
  constructor(parsed, options) {
    this.parsed = parsed;
    this.packages = options.packages ? new Set(options.packages) : null;
    this.files = options.files || {};
    this.maxCommands = options.maxCommands || 100000;
    this.issues = [];
    this.seen = new Set();
    this.executed = 0;
    this.vars = new Map();
    for (const [name, value] of Object.entries(options.vars || {})) {
      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      this.vars.set(name, { style: 'index', values, which: 0, line: 0 });
    }
    this.labelActive = null;
    this.jumpSkip = false;
    this.reset();
  }

  /* Everything `clear` throws away (variables survive it). */
  reset() {
    this.st = {
      units: DEFAULT_UNITS, unitsLine: null, atomStyle: 'atomic', atomStyleLine: null, atomProps: { ...ATOM_STYLES.atomic },
      dimension: 3, boundary: ['p', 'p', 'p'], box: false, boxLine: null, boxHow: '', ntypes: null, fromRestart: false,
      pair: null, bonded: { bond: null, angle: null, dihedral: null, improper: null }, kspace: null,
      pairCoeffs: [], special: { lj: [0, 0, 0], coul: [0, 0, 0], line: null },
      groups: new Map([['all', { line: 0 }]]), regions: new Map(), fixes: new Map(), computes: new Map(),
      dumps: new Map(), molecules: new Map(), timestep: null, thermo: { every: 0, line: null }, thermoStyle: null,
      thermoComputes: new Set(['temp', 'pe', 'press']), runs: [], ran: false, uncertain: false, suffix: null,
      masses: new Set(), lattice: null, newtonPair: true
    };
    for (const id of ['thermo_temp', 'thermo_press', 'thermo_pe']) {
      this.st.computes.set(id, { style: id.slice(7) === 'temp' ? 'temp' : id.slice(7) === 'press' ? 'pressure' : 'pe', group: 'all', line: 0, auto: true });
    }
  }

  /* ---- reporting ---- */

  issue(severity, id, message, extra = {}) {
    const e = this.entry || { line: 0, lastLine: 0 };
    const line = extra.line ?? e.line;
    const key = `${e.file || ''}|${line}|${id}|${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const issue = { line, lastLine: extra.line !== undefined ? extra.line : e.lastLine, severity, id, message, url: extra.url || this.url || '' };
    if (e.file && extra.line === undefined) issue.file = e.file;
    else if (extra.file) issue.file = extra.file;
    if (extra.lammps) issue.lammps = extra.lammps;
    if (extra.related && extra.related.length) issue.related = [...new Set(extra.related)].filter(x => x && x !== line);
    this.issues.push(issue);
    if (severity === 'error' && !this.firstError) {
      this.firstError = issue;
      this.firstErrorAt = this.traceList ? this.traceList.length - 1 : -1;
    }
  }

  /* An error LAMMPS stops on: `lammps` is its own message. */
  error(id, lammps, message, extra = {}) {
    this.issue('error', id, message ? `${message}` : `LAMMPS stops: "${lammps}".`, { ...extra, lammps });
  }

  warn(id, message, extra = {}) { this.issue('warning', id, message, extra); }
  note(id, message, extra = {}) { this.issue('note', id, message, extra); }

  /* ---- running the script ---- */

  run() {
    this.frames = [{ name: '', lines: this.parsed.lines, pc: 0 }];
    try {
      this.runFrames(0);
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
    }
  }

  /*
   * Read commands until the frame stack is back to `depth` frames, the way
   * Input::file reads a file: an include runs its whole file before the
   * command after it, even inside an if.
   */
  runFrames(depth) {
    while (this.frames.length > depth) {
      const f = this.frames[this.frames.length - 1];
      if (f.pc >= f.lines.length) {
        if (this.labelActive) {
          this.entry = f.lines[f.lines.length - 1] || { line: 0, lastLine: 0 };
          const lbl = this.labelActive;
          this.labelActive = null;
          this.error('label-missing', "Label wasn't found in input script",
            `The jump looks for label "${lbl.name}", which does not follow it in the file, so LAMMPS stops.`,
            { line: lbl.line, url: page('jump') });
          throw new Stop();
        }
        this.frames.pop();
        continue;
      }
      const entry = f.lines[f.pc];
      f.pc += 1;
      this.step(entry);
    }
  }

  step(entry) {
    if (entry.kind !== 'command') return;
    if (this.labelActive) {
      // While looking for a label LAMMPS reads lines without substituting.
      if (entry.command === 'label' && entry.args[0] === this.labelActive.name) this.labelActive = null;
      return;
    }
    this.executed += 1;
    if (this.executed > this.maxCommands) {
      this.entry = entry;
      this.note('too-long', `STEMKit stopped following the script after ${this.maxCommands} commands (a long loop); the rest is not checked.`, { url: page('jump') });
      throw new Stop();
    }
    this.exec(entry, entry.code);
  }

  /*
   * Execute one command line: substitute, split and dispatch. `code` is the
   * line without its comment (for if/then and run every, the quoted command).
   */
  exec(entry, code, nested = false) {
    const saved = this.entry;
    this.entry = entry;
    this.url = '';
    (this.traceList || (this.traceList = [])).push({ file: entry.file || '', line: entry.line, text: nested ? code : entry.text });
    this.rawLine = nested ? code : entry.text;
    try {
      if (!nested && entry.error && /quote/.test(entry.error) && !entry.hasVars) {
        this.error('quote', entry.error, `${entry.error}: a quote is opened and not closed (or a closing quote is followed by a letter), so LAMMPS stops.`,
          { url: page('Commands_parse') });
        return;
      }
      let text = code;
      if (nested) {
        const cut = stripComment(code);
        if (cut.error) { this.error('quote', cut.error, null, { url: page('Commands_parse') }); return; }
        text = cut.code;
      }
      const ascii = asciiSubst(text);
      if (ascii.replaced.length || ascii.garbled.length) {
        if (!this.utf8Warned) {
          this.utf8Warned = true;
          this.warn('non-ascii', 'This line has non-ASCII characters. LAMMPS warns ("Detected non-ASCII characters in input") and replaces ' +
            'the look-alikes it knows (curly quotes, non-breaking and other spaces, minus signs)' +
            (ascii.garbled.length ? `, but ${ascii.garbled.map(c => `"${c}"`).join(', ')} it garbles. Retype the line in plain ASCII.` : '.'),
          { url: page('Commands_parse') });
        } else if (ascii.garbled.length) {
          this.warn('non-ascii', `LAMMPS garbles ${ascii.garbled.map(c => `"${c}"`).join(', ')} on this line: retype it in plain ASCII.`, { url: page('Commands_parse') });
        }
        text = ascii.text;
      }
      const sub = this.substitute(text);
      if (sub === null) return;
      const split = splitWords(sub);
      if (split.error) {
        this.error('quote', split.error, null, { url: page('Commands_parse') });
        return;
      }
      if (!split.words.length) return;
      const [command, ...args] = split.words;
      this.dispatch(command, args, split.quoted.slice(1));
    } finally {
      this.entry = saved;
    }
  }

  /* Input::substitute: replace $x, ${name} and $(formula) outside quotes. */
  substitute(text, report = true) {
    const found = findSubstitutions(text);
    if (found.error) {
      if (report) this.error('substitution', found.error, `${found.error}: a "\${" or "$(" is not closed, so LAMMPS stops.`, { url: page('Commands_parse') });
      return null;
    }
    if (!found.refs.length) return text;
    let out = '';
    let at = 0;
    for (const ref of found.refs) {
      out += text.slice(at, ref.start);
      at = ref.end;
      if (ref.kind === 'immediate') {
        if (!/%[0-9 ]*\.[0-9]+[efgEFG]/.test(ref.format)) {
          if (report) this.error('format', 'Incorrect conversion in format string',
            `The format "${ref.format}" in $(${ref.name}:${ref.format}) is not one LAMMPS accepts: give a precision and an e, f or g conversion, e.g. %.3f.`,
            { url: page('Commands_parse') });
          return null;
        }
        const v = this.evaluate(ref.name, 'immediate', report);
        if (v === false) return null;
        out += v === null ? UNKNOWN : formatImmediate(ref.format, v);
        continue;
      }
      const value = this.retrieve(ref.name, report);
      if (value === false) return null;
      out += value;
    }
    return out + text.slice(at);
  }

  /*
   * Variable::retrieve: the text a variable stands for, UNKNOWN when only
   * the run can tell, false (after reporting) when LAMMPS stops.
   */
  retrieve(name, report = true) {
    const v = this.vars.get(name);
    if (!v || (v.values && v.which >= v.values.length) || (v.style === 'loop' && v.which >= v.last)) {
      if (!v && this.st.uncertain) return UNKNOWN;
      if (report) {
        const near = [...this.vars.keys()].find(k => editDistance(k, name) <= 1 && name.length > 1);
        this.error('undefined-variable', `Substitution for illegal variable ${name}`,
          `$${name.length === 1 ? name : `{${name}}`} uses variable "${name}", which is not defined at this point${v ? ' (its values have been used up by next)' : ''}, so LAMMPS stops.` +
          (near ? ` Did you mean ${near}?` : ' Define it with a variable command earlier in the script, or with -var on the command line.'),
          { url: page('variable'), related: v ? [v.line] : [] });
      }
      return false;
    }
    switch (v.style) {
      case 'index': case 'world': case 'universe': case 'string':
        return v.values[v.which];
      case 'loop': case 'uloop': {
        const n = v.which + 1;
        return v.pad ? String(n).padStart(v.pad, '0') : String(n);
      }
      case 'equal': {
        const r = this.evaluate(v.formula, name, report);
        return r === false ? false : r === null ? UNKNOWN : fmtVar(r);
      }
      case 'internal':
        return v.value === null ? UNKNOWN : fmtVar(v.value);
      case 'atom': case 'atomfile':
        if (report) {
          this.error('atom-variable-substitution', `Substitution for illegal variable ${name}`,
            `"${name}" is an ${v.style}-style variable: it holds one value per atom, which $ cannot put in a command, so LAMMPS stops. ` +
            'Use v_' + name + ' where a per-atom value is accepted, or reduce it to a number with compute reduce.',
            { url: page('variable'), related: [v.line] });
        }
        return false;
      default:
        return UNKNOWN;
    }
  }

  /*
   * Evaluate an equal-style formula now. Returns the number, null when it
   * depends on the run, or false after reporting why LAMMPS stops.
   */
  evaluate(formula, owner, report = true, style = 'equal') {
    const env = this.formulaEnv(owner, style, report);
    try {
      return evalFormula(formula, env);
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      if (report && e.crash) {
        this.issue('error', 'charge-crash', `charge() sums the charges of a group, but atom_style ${this.st.atomStyle} has no charges. ` +
          'LAMMPS (29 Aug 2024) does not stop with a message here: it crashes with a segmentation fault. Use an atom style with charges, or remove charge().',
        { url: page('variable'), related: [this.st.atomStyleLine] });
        return false;
      }
      if (report && !e.reported) {
        const who = owner === 'immediate' ? `$(${formula})` : `variable ${owner} (${formula})`;
        this.error('formula', owner === 'immediate' ? e.message : `Variable ${owner}: ${e.message}`,
          `LAMMPS cannot evaluate ${who}: "${e.message}".${formulaHint(e)}`, { url: page('variable'), related: owner !== 'immediate' && this.vars.get(owner) ? [this.vars.get(owner).line] : [] });
      }
      return false;
    }
  }

  formulaEnv(owner, style, report) {
    const self = this;
    const stack = this.evalStack || (this.evalStack = []);
    return {
      style,
      lookup(kind, name, idx = []) {
        const st = self.st;
        const fail = (msg, hint) => {
          const e = new FormulaError(msg, hint);
          throw e;
        };
        if (kind === 'box') {
          if (!st.box) fail('Variable evaluation before simulation box is defined');
          return null;
        }
        if (kind === 'group') {
          if (!st.box) fail('Variable evaluation before simulation box is defined');
          if (!st.groups.has(name) && !st.uncertain && !st.fromRestart) fail(`Group ID ${name} in variable formula does not exist`);
          return null;
        }
        if (kind === 'region') {
          if (!st.regions.has(name) && !st.uncertain) fail(`Region ID ${name} in variable formula does not exist`);
          return null;
        }
        if (kind === 'charges') {
          // LAMMPS 29 Aug 2024 crashes here (a segmentation fault) instead of stopping with a message.
          if (st.atomStyle && !st.atomProps.q && !st.fromRestart && !st.uncertain) {
            const e = new FormulaError('charge() with an atom style without charges');
            e.crash = true;
            throw e;
          }
          return null;
        }
        if (kind === 'compute') {
          if (!st.box) fail('Variable evaluation before simulation box is defined');
          if (!st.computes.has(name)) {
            if (st.uncertain) return null;
            fail(`Invalid compute ID '${name}' in variable formula`);
          }
          // A compute has values only once a run has set it up.
          if (!st.ran || (!st.computes.get(name).initialized && !st.computes.get(name).auto)) fail('Variable formula compute cannot be invoked before initialization by a run');
          return null;
        }
        if (kind === 'fix') {
          if (!st.box) fail('Variable evaluation before simulation box is defined');
          if (!st.fixes.has(name)) {
            if (st.uncertain) return null;
            fail(`Invalid fix ID '${name}' in variable formula`);
          }
          return null;
        }
        if (kind === 'variable') {
          const v = self.vars.get(name);
          if (!v) {
            if (st.uncertain) return null;
            fail(`Invalid variable reference v_${name} in variable formula`);
          }
          if (stack.includes(name)) fail(`Variable ${name}: has a circular dependency`);
          if (v.style === 'equal' || v.style === 'internal') {
            if (idx.length) return null;
            if (v.style === 'internal') return v.value;
            stack.push(name);
            let r;
            try { r = evalFormula(v.formula, self.formulaEnv(name, 'equal', report)); } finally { stack.pop(); }
            // LAMMPS reads another equal-style variable through its text (15 digits).
            return r === null ? null : Number(fmtVar(r));
          }
          if (v.style === 'atom' || v.style === 'atomfile') {
            if (style === 'equal' && !idx.length) fail(`Atom-style variable in equal-style variable formula`);
            return null;
          }
          if (v.style === 'vector') return null;
          if (['index', 'loop', 'world', 'universe', 'uloop', 'string', 'getenv', 'file', 'format', 'python', 'timer'].includes(v.style)) {
            const text = self.retrieve(name, false);
            if (text === false || isUnknown(text)) return null;
            if (!isLammpsNumber(text.trim())) fail(`Variable ${name}: Invalid variable reference v_${name} in variable formula`);
            return Number(text);
          }
          return null;
        }
        if (kind === 'thermo') {
          if (name === 'dt') return self.timestep();
          if (THERMO_DURING_RUN.has(name)) fail(`The variable thermo keyword ${name} cannot be used between runs`);
          const need = THERMO_NEEDS[name];
          if (!need) return null;
          for (const c of need.split(' ')) {
            if (c === 'pe') {
              if (!st.ran || st.energyStale) fail(name === 'etail' ? 'Energy was not tallied on needed timestep for thermo keyword etail' : 'Energy was not tallied on needed timestep');
              if (!st.thermoComputes.has('pe')) fail(`Thermo keyword ${name} in variable requires thermo to use/init potential energy`);
            } else if (!st.ran || !st.thermoComputes.has(c)) {
              fail(`Thermo keyword ${name} in variable requires thermo to use/init ${c === 'temp' ? 'temperature' : 'press'}`);
            }
          }
          return null;
        }
        return null;
      }
    };
  }

  /* The timestep in time units: set, or the default of the units. */
  timestep() {
    if (this.st.timestep && this.st.timestep.value !== null) return this.st.timestep.value;
    if (this.st.timestep) return null;
    const u = UNITS[this.st.units];
    return u ? u.timestep : null;
  }
}

function formulaHint(e) {
  const m = e.message;
  if (/before simulation box/.test(m)) return ' The formula uses something that needs the atoms (a thermo keyword, an atom value or a group); define the box first.';
  if (/before initialization by a run/.test(m)) return ' A compute or thermo quantity has no value before the first run; use it after a run (run 0 is enough).';
  if (/requires thermo to use\/init/.test(m)) return ' Add that keyword to thermo_style, or use a compute (e.g. c_thermo_pe) after a run.';
  if (/Invalid compute ID/.test(m)) return ' Define the compute before the formula is used.';
  if (/Invalid fix ID/.test(m)) return ' Define the fix before the formula is used.';
  if (/Invalid variable reference/.test(m)) return ' Define that variable first.';
  if (/Divide by 0/.test(m)) return ' Check the values that go into the division.';
  if (/Invalid thermo keyword/.test(m)) return ' Formulas accept the thermo keywords of thermo_style custom, constants such as PI, and c_, f_ and v_ references.';
  if (/function/.test(m)) return ' Check the function name and its number of arguments.';
  if (/syntax/.test(m)) return ' Check the operators and parentheses; formulas use + - * / ^ % and comparisons, and v_name for other variables.';
  return '';
}

/* ---- type checks, as utils::numeric, inumeric, logical read values ---- */

/* The message LAMMPS prints when `word` is not of `type`, or null. */
function typeProblem(type, word) {
  if (word === undefined) return null;
  if (isUnknown(word)) return null;
  const t = type.replace(/^\?/, '');
  if (t === 'num' || t === 'float') return isLammpsNumber(word) ? null : `Expected floating point parameter instead of '${word}' in input script or data file`;
  if (t === 'int' || t === 'bigint' || t === 'tagint') return isLammpsInteger(word) ? null : `Expected integer parameter instead of '${word}' in input script or data file`;
  if (t === 'bool') return BOOL_WORDS.has(word) ? null : `Expected boolean parameter instead of '${word}' in input script or data file`;
  if (t === 'numvar') return word.startsWith('v_') || isLammpsNumber(word) ? null : `Expected floating point parameter instead of '${word}' in input script or data file`;
  if (t === 'intvar') return word.startsWith('v_') || isLammpsInteger(word) ? null : `Expected integer parameter instead of '${word}' in input script or data file`;
  if (t.startsWith('choice:')) return t.slice(7).split('|').includes(word) ? null : 'choice';
  return null;
}

const typeWords = { num: 'a number', float: 'a number', int: 'a whole number', bigint: 'a whole number', tagint: 'a whole number', bool: 'yes or no', numvar: 'a number or v_name', intvar: 'a whole number or v_name' };

Object.assign(Machine.prototype, {
  /* ---- dispatch ---- */

  dispatch(cmd, args, quoted) {
    this.cmd = cmd;
    this.args = args;
    this.quoted = quoted;
    this.recordContext(cmd, args);
    this.url = lammpsDocUrl(cmd) || '';
    const st = this.st;
    if (META.has(cmd)) { this[`m_${cmd}`](args, quoted); return; }
    const handler = this[`c_${cmd}`];
    if (handler) { handler.call(this, args, quoted); return; }
    // A command the reference knows: check that this build has it, and the box.
    const info = commandInfo(cmd);
    if (!info || (!info.exists && !info.removed)) {
      const near = didYouMean(cmd, 'command');
      // LAMMPS prints the line as it read it (before $ substitution).
      const shown = (this.rawLine || [cmd, ...args].join(' ')).replace(/\s+$/, '');
      this.error('unknown-command', `Unknown command: ${shown}`,
        `"${cmd}" is not a LAMMPS command, so LAMMPS stops ("Unknown command").` +
        (near ? ` Did you mean ${near}?` : /^\d|^[-+.]/.test(cmd) ? ' A number at the start of a line usually means a continuation "&" is missing on the line before.' : ''),
        { url: page('Commands_all') });
      return;
    }
    if (info.removed) {
      const r = info.removed;
      if (r.status === 'ignored') { this.note('removed-command', `${r.note}`, { url: info.url || this.url }); return; }
      if (r.status === 'renamed') {
        this.warn('renamed-command', `${r.note}`, { url: info.url || this.url });
        // LAMMPS runs the new command through Input::one, which is what it reports if that stops.
        if (r.renamed) this.exec(this.entry, [r.renamed, ...args.map(a => (/\s/.test(a) ? `"${a}"` : a))].join(' '), true);
        return;
      }
      this.error('removed-command', 'This command is no longer available', `${r.note}`, { url: info.url || this.url });
      return;
    }
    if (!this.havePackages(info.packages)) {
      this.error('missing-package', `Unknown command: ${(this.rawLine || [cmd, ...args].join(' ')).replace(/\s+$/, '')}`,
        `${cmd} comes with the ${info.packages.join(' and ')} package${info.packages.length > 1 ? 's' : ''}, which this LAMMPS build does not have, ` +
        'so LAMMPS stops ("Unknown command"). Rebuild LAMMPS with it, or use a build that has it.', { url: info.url || this.url });
      return;
    }
    this.needPackages(info.packages);
    if (NEEDS_BOX[cmd] && !st.box) { this.error('needs-box', NEEDS_BOX[cmd], this.boxMessage(cmd)); return; }
    if (BEFORE_BOX[cmd] && st.box) { this.error('after-box', BEFORE_BOX[cmd], this.afterBoxMessage(cmd)); return; }
    // Commands with several forms (delete_atoms region ..., displace_atoms g random ...) have a table per form.
    const sub = [0, 1].map(k => `${cmd} ${args[k]}`).find(k => SPECS[k]);
    if (sub) this.checkSpec(sub, args);
    else if (SPECS[cmd]) this.checkSpec(cmd, args);
  },

  /* What explainInput needs about a line: its words after substitution and the units, timestep and styles in force. */
  recordContext(cmd, args) {
    const e = this.entry;
    if (!e || !e.line) return;
    const key = `${e.file || ''}|${e.line}`;
    this.contexts = this.contexts || new Map();
    if (this.contexts.has(key) && this.contexts.get(key).command === cmd) return;
    const st = this.st;
    this.contexts.set(key, {
      command: cmd, args: args.slice(), units: st.units, dt: this.timestep(), dtSet: !!st.timestep, atomStyle: st.atomStyle,
      pair: st.pair ? st.pair.style : null, pairSubs: st.pair && st.pair.subs ? st.pair.subs.map(x => x.style) : [], bonded: { ...st.bonded },
      ntypes: st.ntypes, dimension: st.dimension, lattice: st.lattice, regions: st.regions, fixes: new Map(st.fixes)
    });
  },

  havePackages(list) {
    if (!this.packages || !list || !list.length) return true;
    return list.every(p => this.packages.has(p));
  },

  needPackages(list) {
    if (!list) return;
    this.st.needed = this.st.needed || new Set();
    for (const p of list) this.st.needed.add(p);
    (this.needed || (this.needed = new Map()));
    for (const p of list) if (!this.needed.has(p)) this.needed.set(p, this.entry.line);
  },

  boxMessage(cmd) {
    return `${cmd} needs the simulation box, which does not exist yet, so LAMMPS stops ("${NEEDS_BOX[cmd]}"). ` +
      'Create the box first with read_data, read_restart or create_box.';
  },

  afterBoxMessage(cmd) {
    const how = this.st.boxHow ? ` (made by ${this.st.boxHow} on line ${this.st.boxLine})` : '';
    return `${cmd} must come before the simulation box is created${how}, so LAMMPS stops ("${BEFORE_BOX[cmd]}"). Move it above that line.`;
  },

  /*
   * Check that a style exists in this LAMMPS (and build). `kind` is the
   * command that selects it ('fix', 'pair_style'...), `label` the word
   * LAMMPS uses in its message ('fix', 'pair').
   */
  checkStyle(kind, style, label) {
    if (isUnknown(style)) return true;
    const info = commandInfo(kind, style);
    const url = (info && info.url) || lammpsDocUrl(kind) || '';
    if (info && info.removed) {
      const r = info.removed;
      if (r.status === 'renamed' || r.status === 'ignored') { this.warn('renamed-style', r.note, { url }); return true; }
      this.error('removed-style', `This ${label} style is no longer available`, r.note, { url });
      return false;
    }
    if (!info || !info.exists) {
      const near = didYouMean(style, kind === 'min_style' ? 'minimize' : kind === 'run_style' ? 'integrate' : kind.replace(/_style$/, ''));
      const lammps = kind === 'min_style' ? 'Illegal minimize style' : kind === 'run_style' ? 'Illegal integrate style' : `Unrecognized ${label} style '${style}'`;
      this.error('unknown-style', lammps,
        `"${style}" is not a ${label} style of LAMMPS, so LAMMPS stops ("${lammps}").${near ? ` Did you mean ${near}?` : ''}`,
        { url: lammpsDocUrl(kind) || '' });
      return false;
    }
    if (!styleExists(kind, style, { packages: this.packages ? [...this.packages] : null })) {
      const pk = info.packages.filter(p => !this.packages || !this.packages.has(p));
      // LAMMPS names the package of the exact name; for an accelerated variant whose
      // accelerator package is there but whose base style is not, it says so.
      const own = info.package;
      const lammps = own && this.packages && this.packages.has(own)
        ? `Unrecognized ${label} style '${style}' is part of the ${own} package, but seems to be missing because of a dependency`
        : `Unrecognized ${label} style '${style}' is part of the ${own || pk[0]} package which is not enabled in this LAMMPS binary.`;
      this.error('missing-package', lammps,
        `${label} style ${style} comes with the ${pk.join(' and ')} package${pk.length > 1 ? 's' : ''}, which this LAMMPS build does not have, so LAMMPS stops. ` +
        'Use a build with that package, or another style.', { url });
      return false;
    }
    this.needPackages(info.packages);
    return true;
  },

  /* utils::missing_cmd_args */
  missing(what, url) {
    this.error('missing-args', `Illegal ${what} command: missing argument(s)`,
      `${what} needs more arguments than are given, so LAMMPS stops ("Illegal ${what} command: missing argument(s)").`, { url });
  },

  /* A value LAMMPS reads as a number: report and return false when it is not one. */
  need(type, word, what) {
    const p = typeProblem(type, word);
    if (!p) return true;
    if (p === 'choice') return true;
    this.error('bad-value', p, `${what ? `${what}: ` : ''}"${word}" is not ${typeWords[type] || type}, so LAMMPS stops.`);
    return false;
  },

  /*
   * Check a command against its argument table (SPECS). `words` are the
   * words after the command name. Returns {pos, kw: Map} or null when LAMMPS
   * stops.
   */
  checkSpec(key, words, opts = {}) {
    const spec = specFor(key);
    if (!spec) return { kw: new Map(), pos: [], known: false };
    const narg = words.length;
    const title = key;
    if (narg < spec.min) {
      const lammps = (spec.minMsg || `Illegal ${key} command: missing argument(s)`).replace('{narg}', narg).replace('{n}', narg);
      const names = spec.pos.filter(p => p.type !== 'rest').map(p => p.name).filter(Boolean);
      this.error('missing-args', lammps, `${title} needs at least ${PLURAL(spec.min - spec.p, 'argument')} here${names.length ? ` (${names.join(', ')})` : ''}; ` +
        `this line has ${narg - spec.p}, so LAMMPS stops ("${lammps}").`);
      return null;
    }
    if (spec.max !== undefined && narg > spec.max) {
      const lammps = (spec.maxMsg || `Illegal ${key} command`).replace('{narg}', narg);
      this.error('extra-args', lammps, `${title} takes ${PLURAL(spec.max - spec.p, 'argument')}; this line has ${narg - spec.p}, so LAMMPS stops ("${lammps}").`);
      return null;
    }
    const posValues = [];
    let i = spec.p;
    for (const p of spec.pos) {
      if (p.type === 'rest') return { pos: posValues, kw: new Map(), rest: words.slice(i), known: true };
      const w = words[i];
      if (w === undefined) break;
      // An optional value is read only when the word is of its type.
      if (p.optional && !isUnknown(w) && typeProblem(p.type, w)) continue;
      posValues.push(w);
      i += 1;
      if (isUnknown(w) || p.alt.includes(w)) continue;
      const prob = typeProblem(p.type, w);
      if (prob === 'choice') {
        const lammps = p.msg || null;
        this.error('bad-value', lammps || `Illegal ${key} command`, `"${w}" is not allowed${p.name ? ` for ${p.name}` : ''}: ${title} expects ${p.type.slice(7).split('|').join(', ')}, so LAMMPS stops.`);
        return null;
      }
      if (prob) {
        this.error('bad-value', prob, `${p.name ? `${p.name}: ` : ''}"${w}" is not ${typeWords[p.type] || p.type}, so LAMMPS stops.`);
        return null;
      }
      if (p.check && isLammpsNumber(w)) {
        const x = Number(w);
        const lim = Number(p.check.split(' ')[1]);
        const ok = { '>': x > lim, '>=': x >= lim, '<': x < lim, '<=': x <= lim, '!=': x !== lim }[p.check.split(' ')[0]];
        if (ok === false) {
          const lammps = (p.msg || `Illegal ${key} command`).replace('{value}', w).replace(`{${p.name}}`, w);
          const words = { '>': 'greater than', '>=': 'at least', '<': 'less than', '<=': 'at most', '!=': 'other than' };
          this.error('bad-value', lammps, `${p.name || 'This value'} must be ${words[p.check.split(' ')[0]]} ${lim}; ${w} is not, so LAMMPS stops ("${lammps}").`);
          return null;
        }
      }
    }
    const kw = new Map();
    if (!spec.kw || opts.noKeywords) return { pos: posValues, kw, known: true };
    if (opts.kwStart !== undefined) i = Math.max(i, opts.kwStart);
    while (i < narg) {
      const k = words[i];
      if (isUnknown(k)) return { pos: posValues, kw, partial: true, known: true };
      const vals = Object.prototype.hasOwnProperty.call(spec.kw, k) ? spec.kw[k] : undefined;
      if (vals === undefined) {
        const lammps = (spec.unknown || `Illegal ${key} command`).replace('{kw}', k);
        const near = didYouMeanIn(k, Object.keys(spec.kw));
        const all = Object.keys(spec.kw);
        this.error('unknown-keyword', lammps,
          `"${k}" is not a keyword of ${title}, so LAMMPS stops ("${lammps}").` + (near ? ` Did you mean ${near}?` : all.length ? ` Its keywords are ${all.slice(0, 14).join(', ')}${all.length > 14 ? ', ...' : ''}.` : ' It takes no keywords.'));
        return null;
      }
      if (vals[0] === 'rest') { kw.set(k, words.slice(i + 1)); break; }
      const restAt = vals.indexOf('rest');
      if (restAt > 0) {
        // Some values, then everything else (run every N cmd ..., collection/type N t1 t2 ...).
        if (i + restAt >= narg) {
          const lammps = (spec.missing || `Illegal ${key} command: missing argument(s)`).replace('{kw}', k);
          this.error('missing-value', lammps, `Keyword ${k} of ${title} needs more values, but the line ends first, so LAMMPS stops ("${lammps}").`);
          return null;
        }
        for (let j = 0; j < restAt; j++) {
          const prob = typeProblem(vals[j], words[i + 1 + j]);
          if (prob && prob !== 'choice') { this.error('bad-value', prob, `${k}: "${words[i + 1 + j]}" is not ${typeWords[vals[j]] || vals[j]}, so LAMMPS stops.`); return null; }
        }
        kw.set(k, words.slice(i + 1));
        break;
      }
      if (vals[0] === '*exclude') {
        // neigh_modify exclude: type I J, group G1 G2, molecule/intra G, molecule/inter G, none.
        const n = { type: 2, group: 2, 'molecule/intra': 1, 'molecule/inter': 1, none: 0 }[words[i + 1]];
        if (n === undefined) {
          if (isUnknown(words[i + 1] || '')) return { pos: posValues, kw, partial: true, known: true };
          this.error('bad-value', words[i + 1] === undefined ? 'Illegal neigh_modify exclude command: missing argument(s)' : `Unknown neigh_modify exclude keyword: ${words[i + 1]}`,
            `neigh_modify exclude takes type, group, molecule/intra, molecule/inter or none; "${words[i + 1] ?? ''}" is not one, so LAMMPS stops.`);
          return null;
        }
        kw.set(k, words.slice(i + 1, i + 2 + n));
        i += 2 + n;
        continue;
      }
      if (i + vals.length >= narg) {
        const lammps = (spec.missing || `Illegal ${key} command: missing argument(s)`).replace('{kw}', k);
        this.error('missing-value', lammps,
          `Keyword ${k} of ${title} takes ${PLURAL(vals.length, 'value')} (${vals.map(v => typeWords[v] || v.replace(/^choice:/, '').replace(/\|/g, '/')).join(', ')}), ` +
          `but the line ends first, so LAMMPS stops ("${lammps}").`);
        return null;
      }
      const values = words.slice(i + 1, i + 1 + vals.length);
      for (let j = 0; j < vals.length; j++) {
        const prob = typeProblem(vals[j], values[j]);
        if (prob === 'choice') {
          this.error('bad-value', spec.unknown && !spec.unknown.includes('{kw}') ? spec.unknown : `Illegal ${key} command`,
            `"${values[j]}" is not a value of ${k} (${vals[j].slice(7).split('|').join(', ')}), so LAMMPS stops.`);
          return null;
        }
        if (prob) {
          this.error('bad-value', prob, `${k}: "${values[j]}" is not ${typeWords[vals[j]] || vals[j]}, so LAMMPS stops.`);
          return null;
        }
      }
      kw.set(k, values);
      i += 1 + vals.length;
    }
    return { pos: posValues, kw, known: true };
  }
});

/*
 * The argument table of a command or style, read from its compact form:
 * pos entries are 'type:name|alt' (a choice type is 'a|b|c:name'), or
 * [entry, check, message]; kw is 'name=type,type name2=...'.
 */
const specCache = new Map();
function specFor(key) {
  if (specCache.has(key)) return specCache.get(key);
  const raw = SPECS[key];
  let spec = null;
  if (raw) {
    const pos = (raw.pos || []).map(e => {
      const [text, check, msg] = Array.isArray(e) ? e : [e];
      const optional = text.startsWith('?');
      const body = optional ? text.slice(1) : text;
      const colon = body.indexOf(':');
      let type = colon < 0 ? body : body.slice(0, colon);
      const rest = colon < 0 ? '' : body.slice(colon + 1);
      const [name, ...alt] = rest.split('|');
      if (type.includes('|')) type = `choice:${type}`;
      return { type, name, alt, optional, check: check || '', msg: msg || '' };
    });
    const kw = raw.kw === undefined ? null : {};
    if (raw.kw) {
      for (const part of raw.kw.split(' ')) {
        const eq = part.indexOf('=');
        const k = part.slice(0, eq);
        const vals = part.slice(eq + 1);
        kw[k] = vals === '' ? [] : vals.split(',').map(t => (t.includes('|') ? `choice:${t}` : t));
      }
    }
    const required = pos.filter(p => p.type !== 'rest' && !p.optional).length;
    spec = { p: raw.p || 0, pos, kw, min: raw.min ?? ((raw.p || 0) + required), minMsg: raw.minMsg, max: raw.max, maxMsg: raw.maxMsg, unknown: raw.unknown, missing: raw.missing };
  }
  specCache.set(key, spec);
  return spec;
}

function didYouMeanIn(word, names) {
  let best = '';
  let score = Infinity;
  for (const n of names) {
    const d = editDistance(word, n);
    if (d < score) { score = d; best = n; }
  }
  return score <= (word.length <= 4 ? 1 : 2) ? best : '';
}

/*
 * Argument tables: what LAMMPS reads after the command name, from its
 * source. `prefix` words come first (for fix: ID, group, style), then the
 * positional values `pos`, then keyword/value pairs `kw`. Types: num, int,
 * bool, numvar (number or v_name), choice:a|b, word, rest.
 */
const SPECS = {
  'angle_coeff': { p: 0, pos: ['type:angle'] },
  'angle_coeff charmm': { p: 1, pos: ['num:K', 'num:theta0', 'num:K_ub', 'num:r_ub'], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff class2': { p: 1, pos: ['num:theta0', 'num:K2', 'num:K3', 'num:K4'], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff cosine': { p: 1, pos: ['num:K'], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff cosine/delta': { p: 1, pos: ['num:K', 'num:theta0'], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff cosine/periodic': { p: 1, pos: ['num:C', 'int:B', ['int:n', '> 0', 'Incorrect args for angle coefficients']], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff cosine/shift': { p: 1, pos: ['num:Umin', 'num:theta0'], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff cosine/squared': { p: 1, pos: ['num:K', 'num:theta0'], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff fourier': { p: 1, pos: ['num:K', 'num:C0', 'num:C1', 'num:C2'], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff fourier/simple': { p: 1, pos: ['num:K', 'num:c', 'num:n'], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff gaussian': { p: 1, pos: ['num:T', ['int:n', '>= 1', 'Invalid angle style gaussian value for n: {n}'], ['num:A1', '> 0', 'Invalid value for A_0: {A}'], ['num:w1', '> 0', 'Invalid value for w_0: {w}'], 'num:theta01'], min: 6, minMsg: 'Illegal angle_coeff command: missing argument(s)' },
  'angle_coeff harmonic': { p: 1, pos: ['num:K', 'num:theta0'], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff hybrid': { p: 1, pos: ['word:sub-style', 'rest:sub-style'] },
  'angle_coeff quartic': { p: 1, pos: ['num:theta0', 'num:K2', 'num:K3', 'num:K4'], minMsg: 'Incorrect args for angle coefficients' },
  'angle_coeff table': { p: 1, pos: ['file:filename', 'word:keyword'], minMsg: 'Illegal angle_coeff command: must have 3 arguments' },
  'angle_coeff zero': { p: 1, pos: ['?num:theta0'] },
  'angle_style': { p: 0, pos: ['word:style'], minMsg: 'Illegal angle_style command' },
  'angle_style charmm': { p: 1 },
  'angle_style class2': { p: 1 },
  'angle_style cosine': { p: 1 },
  'angle_style cosine/delta': { p: 1 },
  'angle_style cosine/periodic': { p: 1 },
  'angle_style cosine/shift': { p: 1 },
  'angle_style cosine/squared': { p: 1 },
  'angle_style fourier': { p: 1 },
  'angle_style fourier/simple': { p: 1 },
  'angle_style gaussian': { p: 1 },
  'angle_style harmonic': { p: 1 },
  'angle_style hybrid': { p: 1, pos: ['rest:sub-styles'], minMsg: 'Illegal angle_style hybrid command: missing argument(s)' },
  'angle_style quartic': { p: 1 },
  'angle_style table': { p: 1, pos: ['linear|spline:tabstyle', ['int:N', '>= 2', 'Illegal number of angle table entries: {N}']], minMsg: 'Illegal angle_style command: must have 2 arguments' },
  'angle_style zero': { p: 1, kw: 'nocoeff=' },
  'atom_modify': { p: 0, min: 1, minMsg: 'Illegal atom_modify command: missing argument(s)', kw: 'id=bool map=array|hash|yes first=group sort=int,num', unknown: 'Illegal atom_modify command argument: {kw}', missing: 'Illegal atom_modify {kw} command: missing argument(s)' },
  'atom_style': { p: 0, pos: ['angle|atomic|body|bond|charge|ellipsoid|full|hybrid|line|molecular|sphere|template|tri'], minMsg: 'Illegal atom_style command: missing argument(s)' },
  'atom_style angle': { p: 1 },
  'atom_style atomic': { p: 1 },
  'atom_style body': { p: 1, pos: ['word'], minMsg: 'Invalid atom_style body command' },
  'atom_style bond': { p: 1 },
  'atom_style charge': { p: 1 },
  'atom_style ellipsoid': { p: 1 },
  'atom_style full': { p: 1 },
  'atom_style hybrid': { p: 1 },
  'atom_style line': { p: 1 },
  'atom_style molecular': { p: 1 },
  'atom_style sphere': { p: 1, pos: ['?bool:dynamic'] },
  'atom_style template': { p: 1, pos: ['word'], minMsg: 'Illegal atom_style template command' },
  'atom_style tri': { p: 1 },
  'bond_coeff': { p: 0, pos: ['type:bond'] },
  'bond_coeff class2': { p: 1, pos: ['num:r0', 'num:K2', 'num:K3', 'num:K4'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff fene': { p: 1, pos: ['num:K', 'num:R0', 'num:epsilon', 'num:sigma'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff fene/expand': { p: 1, pos: ['num:K', 'num:R0', 'num:epsilon', 'num:sigma', 'num:delta'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff fene/nm': { p: 1, pos: ['num:K', 'num:R0', 'num:E0', 'num:r0', 'num:n', 'num:m'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff gaussian': { p: 1, pos: ['num:T', ['int:n', '>= 1', 'Invalid bond style gaussian value for n: {n}'], ['num:A1', '> 0', 'Invalid value for A_0: {A}'], ['num:w1', '> 0', 'Invalid value for w_0: {w}'], ['num:r01', '> 0', 'Invalid value for r0_0: {r0}']], min: 6, minMsg: 'Illegal bond_coeff command: missing argument(s)' },
  'bond_coeff gromos': { p: 1, pos: ['num:K', 'num:r0'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff harmonic': { p: 1, pos: ['num:K', 'num:r0'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff harmonic/shift': { p: 1, pos: ['num:Umin', 'num:r0', 'num:rc'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff harmonic/shift/cut': { p: 1, pos: ['num:Umin', 'num:r0', 'num:rc'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff hybrid': { p: 1, pos: ['word:sub-style', 'rest:sub-style'] },
  'bond_coeff morse': { p: 1, pos: ['num:D0', 'num:alpha', 'num:r0'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff nonlinear': { p: 1, pos: ['num:epsilon', 'num:r0', 'num:lamda'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff quartic': { p: 1, pos: ['num:K', 'num:B1', 'num:B2', 'num:Rc', 'num:U0'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff special': { p: 1, pos: ['num:factor_lj', 'num:factor_coul'], minMsg: 'Incorrect args for bond coefficients' },
  'bond_coeff table': { p: 1, pos: ['file:filename', 'word:keyword'], minMsg: 'Illegal bond_coeff command: must have 3 arguments' },
  'bond_coeff zero': { p: 1, pos: ['?num:r0'] },
  'bond_style': { p: 0, pos: ['word:style'], minMsg: 'Illegal bond_style command' },
  'bond_style class2': { p: 1 },
  'bond_style fene': { p: 1 },
  'bond_style fene/expand': { p: 1 },
  'bond_style fene/nm': { p: 1 },
  'bond_style gaussian': { p: 1 },
  'bond_style gromos': { p: 1 },
  'bond_style harmonic': { p: 1 },
  'bond_style harmonic/shift': { p: 1 },
  'bond_style harmonic/shift/cut': { p: 1 },
  'bond_style hybrid': { p: 1, pos: ['rest:sub-styles'], minMsg: 'Illegal bond_style hybrid command: missing argument(s)' },
  'bond_style morse': { p: 1 },
  'bond_style nonlinear': { p: 1 },
  'bond_style quartic': { p: 1 },
  'bond_style special': { p: 1 },
  'bond_style table': { p: 1, pos: ['linear|spline:tabstyle', ['int:N', '>= 2', 'Illegal number of bond table entries: {N}']], minMsg: 'Illegal bond_style command: must have 2 arguments' },
  'bond_style zero': { p: 1, kw: 'nocoeff=' },
  'boundary': { p: 0, pos: ['word', 'word', 'word'], minMsg: 'Illegal boundary command: expected 3 arguments but found {n}' },
  'change_box': { p: 0, pos: ['group'], min: 2, minMsg: 'Illegal change_box command: missing argument(s)', kw: 'x=final|delta|scale|volume,rest y=final|delta|scale|volume,rest z=final|delta|scale|volume,rest xy=final|delta,num xz=final|delta,num yz=final|delta,num boundary=word,word,word ortho= triclinic= set= remap= units=box|lattice', unknown: 'Unknown change_box keyword: {kw}', missing: 'Illegal change_box {kw} command: missing argument(s)' },
  'comm_modify': { p: 0, min: 1, minMsg: 'Illegal comm_modify command: missing argument(s)', kw: 'mode=single|multi|multi/old group=group cutoff=num cutoff/multi=type,num cutoff/multi/old=type,num reduce/multi= vel=bool', unknown: 'Unknown comm_modify keyword: {kw}', missing: 'Illegal comm_modify {kw} command: missing argument(s)' },
  'comm_style': { p: 0, pos: ['brick|tiled'], minMsg: 'Illegal comm_style command: missing argument(s)' },
  'compute': { p: 0, pos: ['word:ID', 'group:group-ID', 'word:style'], minMsg: 'Illegal compute command: missing argument(s)' },
  'compute ackland/atom': { p: 3, minMsg: 'Illegal compute ackland/atom command', kw: 'legacy=bool', missing: 'Invalid compute ackland/atom command' },
  'compute aggregate/atom': { p: 3, pos: ['num:cutoff'], minMsg: 'Illegal compute aggregate/atom command' },
  'compute angle': { p: 3, minMsg: 'Illegal compute angle command' },
  'compute angle/local': { p: 3, pos: ['rest:values'], minMsg: 'Illegal compute angle/local command', kw: 'set=theta,word', unknown: 'Illegal compute angle/local command', missing: 'Illegal compute angle/local command' },
  'compute angmom/chunk': { p: 3, pos: ['word:chunk-ID'], minMsg: 'Illegal compute angmom/chunk command: missing argument(s)' },
  'compute bond': { p: 3, minMsg: 'Illegal compute bond command' },
  'compute bond/local': { p: 3, pos: ['rest:values'], minMsg: 'Illegal compute bond/local command', kw: 'set=dist,word', unknown: 'Unknown compute bond/local keyword: {kw}', missing: 'Illegal compute bond/local set command: missing argument(s)' },
  'compute centro/atom': { p: 3, pos: ['word:N'], minMsg: 'Illegal compute centro/atom command', kw: 'axes=bool', unknown: 'Illegal compute centro/atom command1', missing: 'Illegal compute centro/atom command3' },
  'compute centroid/stress/atom': { p: 3, pos: ['word:temp-ID'], minMsg: 'Illegal compute centroid/stress/atom command', kw: 'ke= pair= bond= angle= dihedral= improper= kspace= fix= virial=', unknown: 'Illegal compute centroid/stress/atom command' },
  'compute chunk/atom': { p: 3, pos: ['word:style', 'rest:style'], minMsg: 'Illegal compute chunk/atom command', kw: 'region=word nchunk=once|every limit=int ids=once|nfreq|every compress=bool discard=mixed|no|yes bound=x|y|z,word,word units=box|lattice|reduced pbc=bool', unknown: 'Illegal compute chunk/atom command', missing: 'Illegal compute chunk/atom command' },
  'compute cluster/atom': { p: 3, pos: ['num:cutoff'], minMsg: 'Illegal compute cluster/atom command' },
  'compute cna/atom': { p: 3, pos: [['num:cutoff', '>= 0', 'Illegal compute cna/atom command']], minMsg: 'Illegal compute cna/atom command' },
  'compute cnp/atom': { p: 3, pos: [['num:cutoff', '>= 0', 'Illegal compute cnp/atom command']], minMsg: 'Illegal compute cnp/atom command' },
  'compute com': { p: 3, minMsg: 'Illegal compute com command' },
  'compute com/chunk': { p: 3, pos: ['word:chunk-ID'], minMsg: 'Illegal compute com/chunk command: missing argument(s)' },
  'compute coord/atom': { p: 3, pos: ['cutoff|orientorder:cstyle', 'rest:cutoff'], min: 5, minMsg: 'Illegal compute coord/atom command' },
  'compute count/type': { p: 3, pos: ['atom|bond|angle|dihedral|improper:mode'], minMsg: 'Incorrect number of args for compute count/type command' },
  'compute dihedral': { p: 3, minMsg: 'Illegal compute dihedral command' },
  'compute dihedral/local': { p: 3, pos: ['rest:values'], minMsg: 'Illegal compute dihedral/local command', kw: 'set=phi,word', unknown: 'Illegal compute dihedral/local command', missing: 'Illegal compute dihedral/local command' },
  'compute dipole': { p: 3, pos: ['?word:optional'], minMsg: 'Illegal compute dipole command' },
  'compute dipole/chunk': { p: 3, pos: ['word:chunk-ID', '?word:optional'], minMsg: 'Illegal compute dipole/chunk command: missing argument(s)' },
  'compute displace/atom': { p: 3, kw: 'refresh=word', unknown: 'Illegal compute displace/atom command', missing: 'Illegal compute displace/atom command' },
  'compute entropy/atom': { p: 3, pos: [['num:sigma', '> 0', 'Illegal compute entropy/atom command; sigma must be positive'], ['num:cutoff', '> 0', 'Illegal compute entropy/atom command; cutoff must be positive']], minMsg: 'Illegal compute entropy/atom command; wrong number of arguments', kw: 'avg=bool,num local=bool', unknown: 'Illegal compute entropy/atom command', missing: 'Illegal compute entropy/atom command' },
  'compute erotate/rigid': { p: 3, pos: ['word:rigid'], minMsg: 'Illegal compute erotate/rigid command' },
  'compute erotate/sphere': { p: 3, minMsg: 'Illegal compute erotate/sphere command' },
  'compute erotate/sphere/atom': { p: 3, minMsg: 'Illegal compute erotate/sphere//atom command' },
  'compute fragment/atom': { p: 3, kw: 'single=bool', unknown: 'Illegal compute fragment/atom command', missing: 'Illegal compute fragment/atom command' },
  'compute global/atom': { p: 3, pos: ['word:index', 'rest:global'], minMsg: 'Illegal compute global/atom command: missing argument(s)' },
  'compute group/group': { p: 3, pos: ['group:group2-ID'], minMsg: 'Illegal compute group/group command', kw: 'pair=bool kspace=bool boundary=bool molecule=off|inter|intra', unknown: 'Illegal compute group/group command', missing: 'Illegal compute group/group command' },
  'compute gyration': { p: 3, minMsg: 'Illegal compute gyration command' },
  'compute gyration/chunk': { p: 3, pos: ['word:chunk-ID'], minMsg: 'Illegal compute gyration/chunk command: missing argument(s)', kw: 'tensor=', unknown: 'Illegal compute gyration/chunk command' },
  'compute heat/flux': { p: 3, pos: ['word:ke-ID', 'word:pe-ID', 'word:stress-ID'], minMsg: 'Illegal compute heat/flux command' },
  'compute hexorder/atom': { p: 3, kw: 'degree=num nnn=word cutoff=num', unknown: 'Illegal compute hexorder/atom command', missing: 'Illegal compute hexorder/atom command' },
  'compute improper': { p: 3, minMsg: 'Illegal compute improper command' },
  'compute improper/local': { p: 3, pos: ['rest:values'], minMsg: 'Illegal compute improper/local command' },
  'compute inertia/chunk': { p: 3, pos: ['word:chunk-ID'], minMsg: 'Illegal compute inertia/chunk command: missing argument(s)' },
  'compute ke': { p: 3, minMsg: 'Illegal compute ke command' },
  'compute ke/atom': { p: 3, minMsg: 'Illegal compute ke/atom command' },
  'compute ke/rigid': { p: 3, pos: ['word:rigid'], minMsg: 'Illegal compute ke/rigid command' },
  'compute momentum': { p: 3, minMsg: 'Illegal compute momentum command' },
  'compute msd': { p: 3, kw: 'com=bool average=bool', unknown: 'Unknown compute msd keyword: {kw}', missing: 'Illegal compute msd {kw} command: missing argument(s)' },
  'compute msd/chunk': { p: 3, pos: ['word:chunk-ID'], minMsg: 'Illegal compute msd/chunk command: missing argument(s)' },
  'compute omega/chunk': { p: 3, pos: ['word:chunk-ID'], minMsg: 'Illegal compute omega/chunk command: missing argument(s)' },
  'compute orientorder/atom': { p: 3, unknown: 'Illegal compute orientorder/atom command', missing: 'Illegal compute orientorder/atom command' },
  'compute pair': { p: 3, pos: ['word:pstyle', ['?int:optional', '> 0', 'Illegal compute pair command'], '?epair|evdwl|ecoul:optional'], minMsg: 'Illegal compute pair command: missing argument(s)' },
  'compute pair/local': { p: 3, pos: ['rest:values'], minMsg: 'Illegal compute pair/local command: missing argument(s)', kw: 'cutoff=type|radius', unknown: 'Unknown compute pair/local keyword: {kw}', missing: 'Illegal compute pair/local cutoff command: missing argument(s)' },
  'compute pe': { p: 3, kw: 'pair= bond= angle= dihedral= improper= kspace= fix=', unknown: 'Illegal compute pe command' },
  'compute pe/atom': { p: 3, kw: 'pair= bond= angle= dihedral= improper= kspace= fix=', unknown: 'Illegal compute pe/atom command' },
  'compute pressure': { p: 3, pos: ['word:temp-ID'], minMsg: 'Illegal compute pressure command: missing argument(s)', kw: 'ke= pair= bond= angle= dihedral= improper= kspace= fix= virial= pair/hybrid=word', unknown: 'Illegal compute pressure command' },
  'compute property/atom': { p: 3, pos: ['rest:attribute'], minMsg: 'Illegal compute property/atom command: missing argument(s)' },
  'compute property/chunk': { p: 3, pos: ['word:chunk-ID', 'rest:values'], minMsg: 'Illegal compute property/chunk command: missing argument(s)' },
  'compute property/local': { p: 3, pos: ['rest:attribute'], minMsg: 'Illegal compute property/local command: missing argument(s)', kw: 'cutoff=type|radius', unknown: 'Unknown compute property/local keyword: {kw}', missing: 'Illegal compute property/local cutoff command: missing argument(s)' },
  'compute rdf': { p: 3, pos: [['int:Nbin', '>= 1', 'Illegal compute rdf command']], minMsg: 'Illegal compute rdf command: missing argument(s)', unknown: 'Unknown compute rdf keyword {kw}', missing: 'Illegal compute rdf cutoff command: missing argument(s)' },
  'compute reduce': { p: 3, pos: ['sum|sumsq|sumabs|min|max|ave|avesq|aveabs|maxabs|minabs:mode', 'rest:input'], minMsg: 'Illegal compute reduce command: missing argument(s)', kw: 'replace=int,int inputs=peratom|local', unknown: 'Unknown compute reduce keyword: {kw}', missing: 'Illegal compute reduce replace command: missing argument(s)' },
  'compute reduce/chunk': { p: 3, pos: ['word:chunk-ID', 'sum|min|max:mode', 'rest:per-atom'], minMsg: 'Illegal compute reduce/chunk command: missing argument(s)' },
  'compute reduce/region': { p: 3, pos: ['word:region-ID', 'sum|sumsq|sumabs|min|max|ave|avesq|aveabs|maxabs|minabs:mode', 'rest:input'], minMsg: 'Illegal compute reduce/region command: missing argument(s)', kw: 'replace=int,int inputs=peratom|local', unknown: 'Unknown compute reduce/region keyword: {kw}', missing: 'Illegal compute reduce/region replace command: missing argument(s)' },
  'compute slice': { p: 3, pos: [['int:Nstart', '>= 1', 'Invalid compute slice nstart value {Nstart} < 1'], 'int:Nstop', ['int:Nskip', '>= 1', 'Invalid compute slice nskip value < 1: {Nskip}'], 'rest:global'], minMsg: 'Illegal compute slice command: missing argument(s)' },
  'compute stress/atom': { p: 3, pos: ['word:temp-ID'], minMsg: 'Illegal compute stress/atom command', kw: 'ke= pair= bond= angle= dihedral= improper= kspace= fix= virial=', unknown: 'Illegal compute stress/atom command' },
  'compute stress/cartesian': { p: 3, pos: ['x|y|z:dim1', 'num:bin_width1', 'word:dim2', 'num:bin_width2'], minMsg: 'Illegal compute stress/cartesian command: missing argument(s)', kw: 'ke= pair= bond=', unknown: 'Unknown compute stress/cartesian keyword: {kw}' },
  'compute temp': { p: 3, minMsg: 'Illegal compute temp command' },
  'compute temp/chunk': { p: 3, pos: ['word:chunk-ID'], minMsg: 'Illegal compute temp/chunk command: missing argument(s)', kw: 'com=bool bias=word adof=num cdof=num', unknown: 'Illegal compute temp/chunk command', missing: 'Illegal compute temp/chunk command' },
  'compute temp/com': { p: 3, minMsg: 'Illegal compute temp command' },
  'compute temp/deform': { p: 3, minMsg: 'Illegal compute temp/deform command' },
  'compute temp/partial': { p: 3, pos: ['int:xflag', 'int:yflag', 'int:zflag'], minMsg: 'Illegal compute temp/partial command' },
  'compute temp/profile': { p: 3, pos: ['int:xflag', 'int:yflag', 'int:zflag', 'x|y|z|xy|yz|xz|xyz:binstyle', 'int:Nx'], min: 7, minMsg: 'Illegal compute temp/profile command', kw: 'out=tensor|bin', unknown: 'Illegal compute temp/profile command', missing: 'Illegal compute temp/profile command' },
  'compute temp/ramp': { p: 3, pos: ['vx|vy|vz:vdim', 'num:vlo', 'num:vhi', 'x|y|z:dim', 'num:clo', 'num:chi'], minMsg: 'Illegal compute temp command', kw: 'units=box|lattice', unknown: 'Illegal compute temp/ramp command', missing: 'Illegal compute temp/ramp command' },
  'compute temp/region': { p: 3, pos: ['word:region-ID'], minMsg: 'Illegal compute temp/region command' },
  'compute temp/sphere': { p: 3, kw: 'bias=word dof=all|rotate', unknown: 'Unknown compute temp/sphere keyword {kw}', missing: 'Illegal compute temp/sphere {kw} command: missing argument(s)' },
  'compute torque/chunk': { p: 3, pos: ['word:chunk-ID'], minMsg: 'Illegal compute torque/chunk command: missing argument(s)' },
  'compute vacf': { p: 3 },
  'compute vcm/chunk': { p: 3, pos: ['word:chunk-ID'], minMsg: 'Illegal compute vcm/chunk command: missing argument(s)' },
  'compute_modify': { p: 1, min: 2, minMsg: 'Illegal compute_modify command: missing argument(s)', kw: 'extra/dof=num extra=num dynamic/dof=bool dynamic=bool', unknown: 'Illegal compute_modify command', missing: 'Illegal compute_modify command' },
  'create_atoms': { p: 0, pos: ['type', 'box|region|single|random|mesh'], minMsg: 'Illegal create_atoms command: missing argument(s)', kw: 'basis=int,type remap=bool mol=word,int units=box|lattice var=word set=x|y|z,word rotate=num,num,num,num ratio=num,int subset=bigint,int overlap=num maxtry=int meshmode=bisect|qrand,num radscale=num', unknown: 'Illegal create_atoms command option {kw}', missing: 'Illegal create_atoms {kw} command: missing argument(s)' },
  'create_atoms box': { p: 2, minMsg: 'Illegal create_atoms command: missing argument(s)', kw: 'basis=int,type remap=bool mol=word,int units=box|lattice var=word set=x|y|z,word rotate=num,num,num,num ratio=num,int subset=bigint,int overlap=num maxtry=int meshmode=bisect|qrand,num radscale=num', unknown: 'Illegal create_atoms command option {kw}', missing: 'Illegal create_atoms {kw} command: missing argument(s)' },
  'create_atoms mesh': { p: 2, pos: ['file'], minMsg: 'Illegal create_atoms command: missing argument(s)', kw: 'basis=int,type remap=bool mol=word,int units=box|lattice var=word set=x|y|z,word rotate=num,num,num,num ratio=num,int subset=bigint,int overlap=num maxtry=int meshmode=bisect|qrand,num radscale=num', unknown: 'Illegal create_atoms command option {kw}', missing: 'Illegal create_atoms {kw} command: missing argument(s)' },
  'create_atoms random': { p: 2, pos: [['int:N', '>= 0', 'Illegal create_atoms number of random atoms {N}'], ['int:seed', '> 0', 'Illegal create_atoms random seed {seed}'], 'word'], minMsg: 'Illegal create_atoms command: missing argument(s)', kw: 'basis=int,type remap=bool mol=word,int units=box|lattice var=word set=x|y|z,word rotate=num,num,num,num ratio=num,int subset=bigint,int overlap=num maxtry=int meshmode=bisect|qrand,num radscale=num', unknown: 'Illegal create_atoms command option {kw}', missing: 'Illegal create_atoms {kw} command: missing argument(s)' },
  'create_atoms region': { p: 2, pos: ['word'], minMsg: 'Illegal create_atoms command: missing argument(s)', kw: 'basis=int,type remap=bool mol=word,int units=box|lattice var=word set=x|y|z,word rotate=num,num,num,num ratio=num,int subset=bigint,int overlap=num maxtry=int meshmode=bisect|qrand,num radscale=num', unknown: 'Illegal create_atoms command option {kw}', missing: 'Illegal create_atoms {kw} command: missing argument(s)' },
  'create_atoms single': { p: 2, pos: ['num', 'num', 'num'], minMsg: 'Illegal create_atoms command: missing argument(s)', kw: 'basis=int,type remap=bool mol=word,int units=box|lattice var=word set=x|y|z,word rotate=num,num,num,num ratio=num,int subset=bigint,int overlap=num maxtry=int meshmode=bisect|qrand,num radscale=num', unknown: 'Illegal create_atoms command option {kw}', missing: 'Illegal create_atoms {kw} command: missing argument(s)' },
  'create_bonds': { p: 0, pos: ['many|single/bond|single/angle|single/dihedral|single/improper'], min: 4, minMsg: 'Illegal create_bonds command: missing argument(s)', kw: 'special=bool', unknown: 'Illegal create_bonds command', missing: 'Illegal create_bonds command' },
  'create_bonds many': { p: 1, pos: ['group', 'group', 'int', 'num', 'num'], minMsg: 'Illegal create_bonds command: missing argument(s)', kw: 'special=bool', unknown: 'Illegal create_bonds command', missing: 'Illegal create_bonds command' },
  'create_bonds single/angle': { p: 1, pos: ['int', 'tagint', 'tagint', 'tagint'], minMsg: 'Illegal create_bonds command: missing argument(s)', kw: 'special=bool', unknown: 'Illegal create_bonds command', missing: 'Illegal create_bonds command' },
  'create_bonds single/bond': { p: 1, pos: ['int', 'tagint', 'tagint'], minMsg: 'Illegal create_bonds command: missing argument(s)', kw: 'special=bool', unknown: 'Illegal create_bonds command', missing: 'Illegal create_bonds command' },
  'create_bonds single/dihedral': { p: 1, pos: ['int', 'tagint', 'tagint', 'tagint', 'tagint'], minMsg: 'Illegal create_bonds command: missing argument(s)', kw: 'special=bool', unknown: 'Illegal create_bonds command', missing: 'Illegal create_bonds command' },
  'create_bonds single/improper': { p: 1, pos: ['int', 'tagint', 'tagint', 'tagint', 'tagint'], minMsg: 'Illegal create_bonds command: missing argument(s)', kw: 'special=bool', unknown: 'Illegal create_bonds command', missing: 'Illegal create_bonds command' },
  'create_box': { p: 0, pos: ['int', 'word'], minMsg: 'Illegal create_box command: missing argument(s)', kw: 'bond/types=int angle/types=int dihedral/types=int improper/types=int extra/bond/per/atom=int extra/angle/per/atom=int extra/dihedral/per/atom=int extra/improper/per/atom=int extra/special/per/atom=int', unknown: 'Unknown create_box keyword: {kw}', missing: 'Illegal create_box {kw} command: missing argument(s)' },
  'delete_atoms': { p: 0, pos: ['group|region|overlap|random|variable'], minMsg: 'Illegal delete_atoms command: missing argument(s)', kw: 'compress=bool bond=bool mol=bool', unknown: 'Unknown delete_atoms option: {kw}', missing: 'Illegal delete_atoms {kw} command: missing argument(s)' },
  'delete_atoms group': { p: 1, pos: ['group'], minMsg: 'Illegal delete_atoms command: missing argument(s)', kw: 'compress=bool bond=bool mol=bool', unknown: 'Unknown delete_atoms option: {kw}', missing: 'Illegal delete_atoms {kw} command: missing argument(s)' },
  'delete_atoms overlap': { p: 1, pos: ['num', 'group', 'group'], minMsg: 'Illegal delete_atoms command: missing argument(s)', kw: 'compress=bool bond=bool mol=bool', unknown: 'Unknown delete_atoms option: {kw}', missing: 'Illegal delete_atoms {kw} command: missing argument(s)' },
  'delete_atoms random': { p: 1, pos: ['fraction|count', 'num', 'bool', 'group', 'word', 'int'], minMsg: 'Illegal delete_atoms command: missing argument(s)', kw: 'compress=bool bond=bool mol=bool', unknown: 'Unknown delete_atoms option: {kw}', missing: 'Illegal delete_atoms {kw} command: missing argument(s)' },
  'delete_atoms region': { p: 1, pos: ['word'], minMsg: 'Illegal delete_atoms command: missing argument(s)', kw: 'compress=bool bond=bool mol=bool', unknown: 'Unknown delete_atoms option: {kw}', missing: 'Illegal delete_atoms {kw} command: missing argument(s)' },
  'delete_atoms variable': { p: 1, pos: ['word'], minMsg: 'Illegal delete_atoms command: missing argument(s)', kw: 'compress=bool bond=bool mol=bool', unknown: 'Unknown delete_atoms option: {kw}', missing: 'Illegal delete_atoms {kw} command: missing argument(s)' },
  'delete_bonds': { p: 0, pos: ['group', 'multi|atom|bond|angle|dihedral|improper|stats', '?word'], minMsg: 'Illegal delete_bonds command', kw: 'any= undo= remove= special= induce=', unknown: 'Illegal delete_bonds command' },
  'dihedral_coeff': { p: 0, pos: ['type:dihedral'] },
  'dihedral_coeff charmm': { p: 1, pos: ['num:K', ['int:n', '>= 0', 'Incorrect multiplicity arg for dihedral coefficients'], 'int:d', 'num:w'], minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff charmmfsw': { p: 1, pos: ['num:K', ['int:n', '>= 0', 'Incorrect multiplicity arg for dihedral coefficients'], 'int:d', 'num:w'], minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff class2': { p: 1, pos: ['num:K1', 'num:phi1', 'num:K2', 'num:phi2', 'num:K3', 'num:phi3'], min: 2, minMsg: 'Invalid coeffs for this dihedral style' },
  'dihedral_coeff cosine/shift/exp': { p: 1, pos: ['num:Umin', 'num:theta0', 'num:a'], minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff fourier': { p: 1, pos: [['int:m', '>= 1', 'Incorrect number of terms arg for dihedral coefficients'], 'num:K1', 'int:n1', 'num:d1'], min: 4, minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff harmonic': { p: 1, pos: ['num:K', 'int:d', ['int:n', '>= 0', 'Incorrect multiplicity arg for dihedral coefficients']], minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff helix': { p: 1, pos: ['num:A', 'num:B', 'num:C'], minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff hybrid': { p: 1, pos: ['word:sub-style', 'rest:sub-style'] },
  'dihedral_coeff multi/harmonic': { p: 1, pos: ['num:A1', 'num:A2', 'num:A3', 'num:A4', 'num:A5'], minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff nharmonic': { p: 1, pos: ['int:n', 'num:A1'], min: 3, minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff opls': { p: 1, pos: ['num:K1', 'num:K2', 'num:K3', 'num:K4'], minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff quadratic': { p: 1, pos: [['num:K', '>= 0', 'Incorrect coefficient arg for dihedral coefficients'], 'num:phi0'], minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff table': { p: 1, pos: ['file:filename', 'word:keyword'], minMsg: 'Illegal dihedral_coeff command: must have 3 arguments' },
  'dihedral_coeff table/cut': { p: 1, pos: ['word:aat', 'num:K', 'num:theta1', 'num:theta2', 'file:filename', 'word:keyword'], minMsg: 'Incorrect args for dihedral coefficients' },
  'dihedral_coeff zero': { p: 1 },
  'dihedral_style': { p: 0, pos: ['word:style'], minMsg: 'Illegal dihedral_style command' },
  'dihedral_style charmm': { p: 1 },
  'dihedral_style charmmfsw': { p: 1 },
  'dihedral_style class2': { p: 1 },
  'dihedral_style cosine/shift/exp': { p: 1 },
  'dihedral_style fourier': { p: 1 },
  'dihedral_style harmonic': { p: 1 },
  'dihedral_style helix': { p: 1 },
  'dihedral_style hybrid': { p: 1, pos: ['rest:sub-styles'], minMsg: 'Illegal dihedral_style hybrid command: missing argument(s)' },
  'dihedral_style multi/harmonic': { p: 1 },
  'dihedral_style nharmonic': { p: 1 },
  'dihedral_style opls': { p: 1 },
  'dihedral_style quadratic': { p: 1 },
  'dihedral_style table': { p: 1, pos: ['linear|spline:tabstyle', ['int:N', '>= 3', 'Illegal number of dihedral table entries: {N}']], minMsg: 'Illegal dihedral_style command: must have 2 arguments' },
  'dihedral_style table/cut': { p: 1, pos: ['linear|spline:tabstyle', ['int:N', '>= 3', 'Illegal number of dihedral table entries: {N}']], minMsg: 'Illegal dihedral_style command: must have 2 arguments' },
  'dihedral_style zero': { p: 1, kw: 'nocoeff=' },
  'dimension': { p: 0, pos: ['int:N'], minMsg: 'Dimension command expects exactly 1 argument' },
  'displace_atoms': { p: 0, pos: ['group', 'move|ramp|random|rotate'], minMsg: 'Illegal displace_atoms command', kw: 'units=box|lattice', unknown: 'Illegal displace_atoms command', missing: 'Illegal displace_atoms command' },
  'displace_atoms move': { p: 2, pos: ['numvar', 'numvar', 'numvar'], minMsg: 'Illegal displace_atoms command', kw: 'units=box|lattice', unknown: 'Illegal displace_atoms command', missing: 'Illegal displace_atoms command' },
  'displace_atoms ramp': { p: 2, pos: ['x|y|z', 'num', 'num', 'x|y|z', 'num', 'num'], minMsg: 'Illegal displace_atoms command', kw: 'units=box|lattice', unknown: 'Illegal displace_atoms command', missing: 'Illegal displace_atoms command' },
  'displace_atoms random': { p: 2, pos: ['num', 'num', 'num', ['int:seed', '> 0', 'Illegal displace_atoms random command']], minMsg: 'Illegal displace_atoms command', kw: 'units=box|lattice', unknown: 'Illegal displace_atoms command', missing: 'Illegal displace_atoms command' },
  'displace_atoms rotate': { p: 2, pos: ['num', 'num', 'num', 'num', 'num', 'num', 'num'], minMsg: 'Illegal displace_atoms command', kw: 'units=box|lattice', unknown: 'Illegal displace_atoms command', missing: 'Illegal displace_atoms command' },
  'dump': { p: 0, pos: ['word:dump-ID', 'group:group-ID', 'word:style', ['int:N', '> 0', 'Invalid dump frequency {value}'], 'file:file'], minMsg: 'Illegal dump command' },
  'dump atom': { p: 5, minMsg: 'Illegal dump command', unknown: 'Illegal dump atom command' },
  'dump atom/gz': { p: 5, minMsg: 'Illegal dump command', unknown: 'Illegal dump atom command' },
  'dump cfg': { p: 5, pos: ['mass:mass', 'type:type', 'xs|xsu:x', 'ys|ysu:y', 'zs|zsu:z'], min: 6, minMsg: 'No dump cfg arguments specified', kw: 'id= mol= proc= procp1= type= element= typelabel= mass= x= y= z= xs= ys= zs= xu= yu= zu= xsu= ysu= zsu= ix= iy= iz= vx= vy= vz= fx= fy= fz= q= mux= muy= muz= mu= radius= diameter= omegax= omegay= omegaz= angmomx= angmomy= angmomz= tqx= tqy= tqz=', unknown: 'Invalid attribute {kw} in dump cfg command' },
  'dump cfg/gz': { p: 5, pos: ['mass:mass', 'type:type', 'xs|xsu:x', 'ys|ysu:y', 'zs|zsu:z'], min: 6, minMsg: 'No dump cfg/gz arguments specified', kw: 'id= mol= proc= procp1= type= element= typelabel= mass= x= y= z= xs= ys= zs= xu= yu= zu= xsu= ysu= zsu= ix= iy= iz= vx= vy= vz= fx= fy= fz= q= mux= muy= muz= mu= radius= diameter= omegax= omegay= omegaz= angmomx= angmomy= angmomz= tqx= tqy= tqz=', unknown: 'Invalid attribute {kw} in dump cfg/gz command' },
  'dump custom': { p: 5, min: 6, minMsg: 'No dump custom arguments specified', kw: 'id= mol= proc= procp1= type= element= typelabel= mass= x= y= z= xs= ys= zs= xu= yu= zu= xsu= ysu= zsu= ix= iy= iz= vx= vy= vz= fx= fy= fz= q= mux= muy= muz= mu= radius= diameter= omegax= omegay= omegaz= angmomx= angmomy= angmomz= tqx= tqy= tqz=', unknown: 'Invalid attribute {kw} in dump custom command' },
  'dump custom/gz': { p: 5, min: 6, minMsg: 'No dump custom/gz arguments specified', kw: 'id= mol= proc= procp1= type= element= typelabel= mass= x= y= z= xs= ys= zs= xu= yu= zu= xsu= ysu= zsu= ix= iy= iz= vx= vy= vz= fx= fy= fz= q= mux= muy= muz= mu= radius= diameter= omegax= omegay= omegaz= angmomx= angmomy= angmomz= tqx= tqy= tqz=', unknown: 'Invalid attribute {kw} in dump custom/gz command' },
  'dump dcd': { p: 5, minMsg: 'Illegal dump command', unknown: 'Illegal dump dcd command' },
  'dump h5md': { p: 5, min: 6, minMsg: 'Illegal dump h5md command', kw: 'position=rest image= velocity=rest force=rest species=rest charge=rest file_from=word box=bool create_group=bool author=word', unknown: 'Invalid argument to dump h5md', missing: 'Invalid number of arguments in dump h5md' },
  'dump image': { p: 5, pos: ['word:color-attribute', 'word:diameter-attribute'], min: 6, minMsg: 'No dump image arguments specified', kw: 'atom=bool adiam=num bond=none|atom|type,word grid=word line=type,num tri=type,int,num body=type,num,num fix=word,type,num,num size=int,int view=numvar,numvar center=s|d,numvar,numvar,numvar up=numvar,numvar,numvar zoom=numvar box=bool,num axes=bool,num,num subbox=bool,num shiny=num fsaa=bool ssao=bool,int,num', unknown: 'Illegal dump image command', missing: 'Illegal dump image command' },
  'dump local/gz': { p: 5, min: 6, minMsg: 'No dump local arguments specified', kw: 'index=', unknown: 'Invalid attribute {kw} in dump local command' },
  'dump movie': { p: 5, pos: ['word:color-attribute', 'word:diameter-attribute'], min: 6, minMsg: 'No dump movie arguments specified', kw: 'atom=bool adiam=num bond=none|atom|type,word grid=word line=type,num tri=type,int,num body=type,num,num fix=word,type,num,num size=int,int view=numvar,numvar center=s|d,numvar,numvar,numvar up=numvar,numvar,numvar zoom=numvar box=bool,num axes=bool,num,num subbox=bool,num shiny=num fsaa=bool ssao=bool,int,num', unknown: 'Illegal dump image command', missing: 'Illegal dump image command' },
  'dump xtc': { p: 5, minMsg: 'Illegal dump command', unknown: 'Illegal dump xtc command' },
  'dump xyz': { p: 5, minMsg: 'Illegal dump command', unknown: 'Illegal dump xyz command' },
  'dump xyz/gz': { p: 5, minMsg: 'Illegal dump command', unknown: 'Illegal dump xyz command' },
  'dump yaml': { p: 5, min: 6, minMsg: 'No dump yaml arguments specified', kw: 'id= mol= proc= procp1= type= element= typelabel= mass= x= y= z= xs= ys= zs= xu= yu= zu= xsu= ysu= zsu= ix= iy= iz= vx= vy= vz= fx= fy= fz= q= mux= muy= muz= mu= radius= diameter= omegax= omegay= omegaz= angmomx= angmomy= angmomz= tqx= tqy= tqz=', unknown: 'Invalid attribute {kw} in dump yaml command' },
  'dump_modify': { p: 0, pos: ['word:dump-ID'], min: 2, minMsg: 'Illegal dump_modify command: missing argument(s)', kw: 'append=bool balance=bool buffer=bool colname=word,word delay=bigint every=numvar every/time=numvar fileper=int first=bool flush=bool format=word,word header=bool maxfiles=int nfile=int pad=int pbc=bool skip=word sort=word time=bool units=bool scale=bool image=bool triclinic/general=bool region=word element=rest refresh=word thresh=word,word,word thermo=bool types=numeric|labels label=word unwrap=bool precision=num sfactor=num tfactor=num acolor=type,word adiam=type,num amap=rest gmap=rest bcolor=type,word bdiam=type,num backcolor=word boxcolor=word color=word,num,num,num bitrate=int framerate=num compression_level=int checksum=bool', unknown: 'Unknown dump_modify keyword: {kw}', missing: 'Illegal dump_modify {kw} command: missing argument(s)' },
  'fix': { p: 0, pos: ['word:ID', 'group:group-ID', 'word:style'], minMsg: 'Illegal fix command: missing argument(s)' },
  'fix acks2/reaxff': { p: 3, pos: [['int:N', '> 0', 'Illegal fix qeq/reaxff command'], 'num:cutlo', 'num:cuthi', 'num:tol', 'word:params'], min: 8, minMsg: 'Illegal fix qeq/reaxff command', kw: 'dual= nowarn= maxiter=num', unknown: 'Illegal fix acks2/reaxff command', missing: 'Illegal fix acks2/reaxff command' },
  'fix addforce': { p: 3, pos: ['numvar:fx', 'numvar:fy', 'numvar:fz'], minMsg: 'Illegal fix addforce command: missing argument(s)', kw: 'every=int region=word energy=word', unknown: 'Unknown fix addforce keyword: {kw}', missing: 'Illegal fix addforce {kw} command: missing argument(s)' },
  'fix atom/swap': { p: 3, pos: [['int:N', '> 0', 'Illegal fix atom/swap command'], ['int:X', '>= 0', 'Illegal fix atom/swap command'], ['int:seed', '> 0', 'Illegal fix atom/swap command'], ['num:T', '> 0', 'Illegal fix atom/swap command']], min: 10, minMsg: 'Illegal fix atom/swap command', kw: 'region=word ke=bool semi-grand=bool types=type,type mu=num', unknown: 'Illegal fix atom/swap command', missing: 'Illegal fix atom/swap command' },
  'fix ave/atom': { p: 3, pos: ['int:Nevery', 'int:Nrepeat', 'int:Nfreq'], min: 7, minMsg: 'Illegal fix ave/atom command: missing argument(s)', unknown: 'Invalid fix ave/atom argument: {kw}' },
  'fix ave/chunk': { p: 3, pos: ['int:Nevery', 'int:Nrepeat', 'int:Nfreq', 'word:chunkID'], min: 7, minMsg: 'Illegal fix ave/chunk command: missing argument(s)', kw: 'norm=all|sample|none ave=one|running|window bias=word adof=num cdof=num file=file append=file overwrite= format=word title1=word title2=word title3=word', unknown: 'Unknown fix ave/chunk keyword: {kw}', missing: 'Illegal fix ave/chunk {kw} command: missing argument(s)' },
  'fix ave/correlate': { p: 3, pos: ['int:Nevery', 'int:Nrepeat', 'int:Nfreq'], min: 7, minMsg: 'Illegal fix ave/correlate command: missing argument(s)', kw: 'type=auto|upper|lower|auto/upper|auto/lower|full ave=one|running start=int prefactor=num file=file overwrite= title1=word title2=word title3=word', unknown: 'Unkown fix ave/correlate keyword: {kw}', missing: 'Illegal fix ave/correlate {kw} command: missing argument(s)' },
  'fix ave/correlate/long': { p: 3, pos: ['int:Nevery', 'int:Nfreq'], min: 6, minMsg: 'Illegal fix ave/correlate/long command: missing argument(s)', kw: 'type=auto|upper|lower|auto/upper|auto/lower|full start=int ncorr=int nlen=int ncount=int file=file overwrite= title1=word title2=word', unknown: 'Unknown fix ave/correlate/long keyword: {kw}', missing: 'Illegal fix ave/correlate/long {kw} command: missing argument(s)' },
  'fix ave/histo': { p: 3, pos: ['int:Nevery', 'int:Nrepeat', 'int:Nfreq', 'num:lo', 'num:hi', 'int:Nbins'], min: 10, minMsg: 'Illegal fix ave/histo command: missing argument(s)', kw: 'file=file append=file kind=global|peratom|local ave=one|running|window start=int mode=scalar|vector beyond=ignore|end|extra overwrite= title1=word title2=word title3=word', unknown: 'Unknown fix ave/histo option: {kw}', missing: 'Illegal fix ave/histo {kw} command: missing argument(s)' },
  'fix ave/histo/weight': { p: 3, pos: ['int:Nevery', 'int:Nrepeat', 'int:Nfreq', 'num:lo', 'num:hi', 'int:Nbins'], min: 10, minMsg: 'Illegal fix ave/histo/weight command: missing argument(s)', kw: 'file=file append=file kind=global|peratom|local ave=one|running|window start=int mode=scalar|vector beyond=ignore|end|extra overwrite= title1=word title2=word title3=word', unknown: 'Unknown fix ave/histo/weight option: {kw}', missing: 'Illegal fix ave/histo/weight {kw} command: missing argument(s)' },
  'fix ave/time': { p: 3, pos: ['int:Nevery', 'int:Nrepeat', 'int:Nfreq'], min: 7, minMsg: 'Illegal fix ave/time command: missing argument(s)', kw: 'file=file append=file ave=one|running|window start=int mode=scalar|vector off=int overwrite= format=word title1=word title2=word title3=word', unknown: 'Unknown fix ave/time keyword {kw}', missing: 'Illegal fix ave/time {kw} command: missing argument(s)' },
  'fix aveforce': { p: 3, pos: ['numvar:fx|NULL', 'numvar:fy|NULL', 'numvar:fz|NULL'], minMsg: 'Illegal fix aveforce command', kw: 'region=word', unknown: 'Illegal fix aveforce command', missing: 'Illegal fix aveforce command' },
  'fix bond/break': { p: 3, pos: [['int:Nevery', '> 0', 'Illegal fix bond/break command'], 'type:bondtype', ['num:Rmax', '>= 0', 'Illegal fix bond/break command']], min: 6, minMsg: 'Illegal fix bond/break command', kw: 'prob=num,int', unknown: 'Illegal fix bond/break command', missing: 'Illegal fix bond/break command' },
  'fix bond/create': { p: 3, pos: ['int:Nevery', 'type:itype', 'type:jtype', 'num:Rmin', 'type:bondtype'], min: 8, minMsg: 'Illegal fix bond/create command', kw: 'iparam=int,type jparam=int,type prob=num,int atype=type dtype=type itype=type', unknown: 'Illegal fix bond/create command', missing: 'Illegal fix bond/create command' },
  'fix bond/create/angle': { p: 3, pos: ['int:Nevery', 'type:itype', 'type:jtype', 'num:Rmin', 'type:bondtype'], min: 8, minMsg: 'Illegal fix bond/create command', kw: 'iparam=int,type jparam=int,type prob=num,int atype=type dtype=type itype=type aconstrain=num,int', unknown: 'Illegal fix bond/create command', missing: 'Illegal fix bond/create command' },
  'fix bond/swap': { p: 3, pos: [['int:Nevery', '> 0', 'Illegal fix bond/swap command'], 'num:fraction', 'num:cutoff', 'int:seed'], minMsg: 'Illegal fix bond/swap command', unknown: 'Illegal fix bond/swap command', missing: 'Illegal fix bond/swap command' },
  'fix box/relax': { p: 3, min: 5, minMsg: 'Illegal fix box/relax command: missing argument(s)', kw: 'iso=num aniso=num tri=num x=num y=num z=num xy=num xz=num yz=num couple=xyz|xy|yz|xz|none dilate=all|partial vmax=num nreset=int scalexy=bool scalexz=bool scaleyz=bool fixedpoint=num,num,num', unknown: 'Unknown fix box/relax keyword {kw}', missing: 'Illegal fix box/relax {kw} command: missing argument(s)' },
  'fix deform': { p: 3, pos: [['int:N', '> 0', 'Fix deform Nevery must be > 0']], minMsg: 'Illegal fix deform command: missing argument(s)', kw: 'x=rest y=rest z=rest xy=rest xz=rest yz=rest remap=x|v|none units=box|lattice flip=bool', unknown: 'Unknown fix deform keyword: {kw}', missing: 'Illegal fix deform {kw} command: missing argument(s)' },
  'fix deposit': { p: 3, pos: ['int:N', 'type:type', 'int:M', ['int:seed', '> 0', 'Illegal fix deposit command']], min: 7, minMsg: 'Illegal fix deposit command', kw: 'region=word var=word set=x|y|z,word mol=word molfrac=num rigid=word shake=word id=max|next global=num,num local=num,num,num near=num attempt=int rate=num vx=num,num vy=num,num vz=num,num orient=num,num,num units=box|lattice gaussian=num,num,num,num target=num,num,num', unknown: 'Illegal fix deposit command', missing: 'Illegal fix deposit command' },
  'fix drude': { p: 3, pos: ['word:type-flag'], minMsg: 'Illegal fix drude command' },
  'fix drude/transform/direct': { p: 3, max: 3, maxMsg: 'Illegal fix drude/transform command' },
  'fix drude/transform/inverse': { p: 3, max: 3, maxMsg: 'Illegal fix drude/transform command' },
  'fix dt/reset': { p: 3, pos: [['int:N', '> 0', 'Illegal fix dt/reset command'], ['num:Tmin|NULL', '>= 0', 'Illegal fix dt/reset command'], 'num:Tmax|NULL', ['num:Xmax', '> 0', 'Illegal fix dt/reset command']], minMsg: 'Illegal fix dt/reset command', kw: 'units=box|lattice emax=num', unknown: 'Illegal fix dt/reset command', missing: 'Illegal fix dt/reset command' },
  'fix efield': { p: 3, pos: ['numvar:ex', 'numvar:ey', 'numvar:ez'], minMsg: 'Illegal fix efield command: missing argument(s)', kw: 'region=word energy=word potential=word', unknown: 'Unknown keyword for fix efield command: {kw}', missing: 'Illegal fix efield region command: missing argument(s)' },
  'fix enforce2d': { p: 3, max: 3, maxMsg: 'Illegal fix enforce2d command' },
  'fix evaporate': { p: 3, pos: [['int:N', '> 0', 'Illegal fix evaporate command'], ['int:M', '> 0', 'Illegal fix evaporate command'], 'word:region', ['int:seed', '> 0', 'Illegal fix evaporate command']], min: 7, minMsg: 'Illegal fix evaporate command', kw: 'molecule=bool', unknown: 'Illegal fix evaporate command', missing: 'Illegal fix evaporate command' },
  'fix gld': { p: 3, pos: ['num:Tstart', 'num:Tstop', 'int:N_k', 'int:seed', 'pprony:series'], min: 8, minMsg: 'Illegal fix gld command', kw: 'zero=bool frozen=bool', unknown: 'Illegal fix gld command', missing: 'Illegal fix gld command' },
  'fix gravity': { p: 3, pos: ['numvar:magnitude', 'chute|spherical|vector:style'], min: 5, minMsg: 'Illegal fix gravity command', kw: 'disable=', unknown: 'Illegal fix gravity command' },
  'fix heat': { p: 3, pos: [['int:N', '> 0', 'Illegal fix heat command'], 'numvar:eflux'], min: 4, minMsg: 'Illegal fix heat command', kw: 'region=word', unknown: 'Illegal fix heat command', missing: 'Illegal fix heat command' },
  'fix indent': { p: 3, pos: [['num:K', '>= 0', 'Illegal fix indent force constant: {val}'], 'sphere|cylinder|cone|plane:geometry'], minMsg: 'Illegal fix indent command: missing argument(s)', unknown: 'Unknown fix indent argument: {kw}', missing: 'Illegal fix indent {kw} command: missing argument(s)' },
  'fix langevin': { p: 3, pos: ['numvar:Tstart', 'num:Tstop', ['num:damp', '> 0', 'Fix langevin period must be > 0.0'], ['int:seed', '> 0', 'Illegal fix langevin command']], minMsg: 'Illegal fix langevin command', kw: 'angmom=num gjf=no|vfull|vhalf omega=bool scale=int,num tally=bool zero=bool', unknown: 'Illegal fix langevin command', missing: 'Illegal fix langevin command' },
  'fix langevin/drude': { p: 3, pos: ['numvar:Tcom', ['num:damp_com', '> 0', 'Fix langevin/drude period must be > 0.0'], ['int:seed_com', '> 0', 'Illegal langevin/drude seed'], 'num:Tdrude', ['num:damp_drude', '> 0', 'Fix langevin/drude period must be > 0.0'], ['int:seed_drude', '> 0', 'Illegal langevin/drude seed']], minMsg: 'Illegal fix langevin/drude command', kw: 'zero=bool', unknown: 'Illegal fix langevin/drude command', missing: 'Illegal fix langevin/drude command' },
  'fix lineforce': { p: 3, pos: ['num', 'num', 'num'], minMsg: 'Illegal fix lineforce command', max: 6, maxMsg: 'Illegal fix lineforce command' },
  'fix momentum': { p: 3, pos: [['int:N', '> 0', 'Illegal fix momentum command']], minMsg: 'Illegal fix momentum command', kw: 'linear=int,int,int angular= rescale=', unknown: 'Illegal fix momentum command', missing: 'Illegal fix momentum command' },
  'fix nph': { p: 3, min: 4, minMsg: 'Illegal fix nph command: missing argument(s)', kw: 'temp=num,num,num iso=num,num,num aniso=num,num,num tri=num,num,num x=num,num,num y=num,num,num z=num,num,num xy=num,num,num xz=num,num,num yz=num,num,num couple=xyz|xy|yz|xz|none drag=num ptemp=num dilate=word tchain=int pchain=int mtk=bool tloop=int ploop=int nreset=int scalexy=bool scalexz=bool scaleyz=bool flip=bool update=dipole|dipole/dlm fixedpoint=num,num,num disc= erate=word,word strain=word,word ext=word psllod=word', unknown: 'Unknown fix nph keyword: {kw}', missing: 'Illegal fix nph {kw} command: missing argument(s)' },
  'fix npt': { p: 3, min: 4, minMsg: 'Illegal fix npt command: missing argument(s)', kw: 'temp=num,num,num iso=num,num,num aniso=num,num,num tri=num,num,num x=num,num,num y=num,num,num z=num,num,num xy=num,num,num xz=num,num,num yz=num,num,num couple=xyz|xy|yz|xz|none drag=num ptemp=num dilate=word tchain=int pchain=int mtk=bool tloop=int ploop=int nreset=int scalexy=bool scalexz=bool scaleyz=bool flip=bool update=dipole|dipole/dlm fixedpoint=num,num,num disc= erate=word,word strain=word,word ext=word psllod=word', unknown: 'Unknown fix npt keyword: {kw}', missing: 'Illegal fix npt {kw} command: missing argument(s)' },
  'fix nve': { p: 3 },
  'fix nve/limit': { p: 3, pos: ['num:xmax'], minMsg: 'Illegal fix nve/limit command: missing argument(s)', max: 4, maxMsg: 'Illegal fix nve/limit command: missing argument(s)' },
  'fix nve/noforce': { p: 3, max: 3, maxMsg: 'Illegal fix nve/noforce command: missing argument(s)' },
  'fix nvt': { p: 3, min: 4, minMsg: 'Illegal fix nvt command: missing argument(s)', kw: 'temp=num,num,num iso=num,num,num aniso=num,num,num tri=num,num,num x=num,num,num y=num,num,num z=num,num,num xy=num,num,num xz=num,num,num yz=num,num,num couple=xyz|xy|yz|xz|none drag=num ptemp=num dilate=word tchain=int pchain=int mtk=bool tloop=int ploop=int nreset=int scalexy=bool scalexz=bool scaleyz=bool flip=bool update=dipole|dipole/dlm fixedpoint=num,num,num disc= erate=word,word strain=word,word ext=word psllod=word', unknown: 'Unknown fix nvt keyword: {kw}', missing: 'Illegal fix nvt {kw} command: missing argument(s)' },
  'fix nvt/sllod': { p: 3, min: 4, minMsg: 'Illegal fix nvt/sllod command: missing argument(s)', kw: 'temp=num,num,num iso=num,num,num aniso=num,num,num tri=num,num,num x=num,num,num y=num,num,num z=num,num,num xy=num,num,num xz=num,num,num yz=num,num,num couple=xyz|xy|yz|xz|none drag=num ptemp=num dilate=word tchain=int pchain=int mtk=bool tloop=int ploop=int nreset=int scalexy=bool scalexz=bool scaleyz=bool flip=bool update=dipole|dipole/dlm fixedpoint=num,num,num disc= erate=word,word strain=word,word ext=word psllod=bool', unknown: 'Unknown fix nvt/sllod keyword: {kw}', missing: 'Illegal fix nvt/sllod {kw} command: missing argument(s)' },
  'fix oneway': { p: 3, pos: [['int:N', '>= 1', 'Illegal fix oneway command'], 'word:region-ID', 'word:direction'], minMsg: 'Illegal fix oneway command' },
  'fix planeforce': { p: 3, pos: ['num', 'num', 'num'], minMsg: 'Illegal fix planeforce command', max: 6, maxMsg: 'Illegal fix planeforce command' },
  'fix plumed': { p: 3, kw: 'plumedfile=file outfile=file', unknown: 'Syntax error - use \'fix <fix-ID> plumed plumedfile plumed.dat outfile plumed.out\' ', missing: 'missing argument for {kw} option' },
  'fix press/berendsen': { p: 3, min: 5, minMsg: 'Illegal fix press/berendsen command', kw: 'iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none modulus=num dilate=all|partial', unknown: 'Illegal fix press/berendsen command', missing: 'Illegal fix press/berendsen command' },
  'fix print': { p: 3, pos: ['numvar:N', 'word:string'], minMsg: 'Illegal fix print command: missing argument(s)', kw: 'file=file append=file screen=bool title=word', unknown: 'Unknown fix print keyword: {kw}', missing: 'Illegal fix print {kw} command: missing argument(s)' },
  'fix property/atom': { p: 3, min: 4, minMsg: 'Illegal fix property/atom command', unknown: 'Illegal fix property/atom command', missing: 'Illegal fix property/atom command' },
  'fix qeq/point': { p: 3, pos: ['int:N', 'num:cutoff', 'num:tol', 'int:maxiter', 'word:qfile'], min: 8, minMsg: 'Illegal fix qeq/point command: missing argument(s)', kw: 'warn=bool', unknown: 'Illegal fix qeq/point command', missing: 'Illegal fix qeq/point command' },
  'fix qeq/reaxff': { p: 3, pos: [['int:N', '> 0', 'Illegal fix qeq/reaxff command'], 'num:cutlo', 'num:cuthi', 'num:tol', 'word:params'], min: 8, minMsg: 'Illegal fix qeq/reaxff command', kw: 'dual= nowarn= maxiter=num', unknown: 'Illegal fix qeq/reaxff command', missing: 'Illegal fix qeq/reaxff command' },
  'fix qeq/shielded': { p: 3, pos: ['int:N', 'num:cutoff', 'num:tol', 'int:maxiter', 'word:qfile'], min: 8, minMsg: 'Illegal fix qeq/shielded command: missing argument(s)', kw: 'warn=bool', unknown: 'Illegal fix qeq/shielded command', missing: 'Illegal fix qeq/shielded command' },
  'fix rattle': { p: 3, pos: ['num:tol', 'int:iter', 'int:N'], min: 8, minMsg: 'Illegal fix rattle command: missing argument(s)', kw: 'mol=word kbond=num', unknown: 'Unknown fix rattle command option: {kw}', missing: 'Illegal fix rattle {kw} command: missing argument(s)' },
  'fix recenter': { p: 3, pos: ['num:x|NULL|INIT', 'num:y|NULL|INIT', 'num:z|NULL|INIT'], minMsg: 'Illegal fix recenter command', kw: 'shift=group units=box|lattice|fraction', unknown: 'Illegal fix recenter command' },
  'fix restrain': { p: 3, min: 4, minMsg: 'Illegal fix restrain command', kw: 'bond=tagint,tagint,num,num,num lbound=tagint,tagint,num,num,num angle=tagint,tagint,tagint,num,num,num dihedral=tagint,tagint,tagint,tagint,num,num,num', unknown: 'Illegal fix restrain command', missing: 'Illegal fix restrain command' },
  'fix rigid': { p: 3, pos: ['single|molecule|custom|group:bodystyle'], min: 4, minMsg: 'Illegal fix rigid command: missing argument(s)', kw: 'force=word,on|off,on|off,on|off torque=word,on|off,on|off,on|off langevin=num,num,num,int temp=num,num,num iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none dilate=word tparam=int,int,int pchain=int infile=file reinit=bool gravity=word', unknown: 'Illegal fix rigid command', missing: 'Illegal fix rigid {kw} command: missing argument(s)' },
  'fix rigid/nph': { p: 3, pos: ['single|molecule|custom|group:bodystyle'], min: 4, minMsg: 'Illegal fix rigid/nph command: missing argument(s)', kw: 'force=word,on|off,on|off,on|off torque=word,on|off,on|off,on|off langevin=num,num,num,int temp=num,num,num iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none dilate=word tparam=int,int,int pchain=int infile=file reinit=bool gravity=word', unknown: 'Illegal fix rigid/nph command', missing: 'Illegal fix rigid/nph {kw} command: missing argument(s)' },
  'fix rigid/nph/small': { p: 3, pos: ['molecule|custom:bodystyle'], min: 4, minMsg: 'Illegal fix rigid/nph/small command: missing argument(s)', kw: 'langevin=num,num,num,int infile=file reinit=bool mol=word temp=num,num,num iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none dilate=word tparam=int,int,int pchain=int gravity=word', unknown: 'Unknown fix rigid/nph/small keyword {kw}', missing: 'Illegal fix rigid/nph/small {kw} command' },
  'fix rigid/npt': { p: 3, pos: ['single|molecule|custom|group:bodystyle'], min: 4, minMsg: 'Illegal fix rigid/npt command: missing argument(s)', kw: 'force=word,on|off,on|off,on|off torque=word,on|off,on|off,on|off langevin=num,num,num,int temp=num,num,num iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none dilate=word tparam=int,int,int pchain=int infile=file reinit=bool gravity=word', unknown: 'Illegal fix rigid/npt command', missing: 'Illegal fix rigid/npt {kw} command: missing argument(s)' },
  'fix rigid/npt/small': { p: 3, pos: ['molecule|custom:bodystyle'], min: 4, minMsg: 'Illegal fix rigid/npt/small command: missing argument(s)', kw: 'langevin=num,num,num,int infile=file reinit=bool mol=word temp=num,num,num iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none dilate=word tparam=int,int,int pchain=int gravity=word', unknown: 'Unknown fix rigid/npt/small keyword {kw}', missing: 'Illegal fix rigid/npt/small {kw} command' },
  'fix rigid/nve': { p: 3, pos: ['single|molecule|custom|group:bodystyle'], min: 4, minMsg: 'Illegal fix rigid/nve command: missing argument(s)', kw: 'force=word,on|off,on|off,on|off torque=word,on|off,on|off,on|off langevin=num,num,num,int temp=num,num,num iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none dilate=word tparam=int,int,int pchain=int infile=file reinit=bool gravity=word', unknown: 'Illegal fix rigid/nve command', missing: 'Illegal fix rigid/nve {kw} command: missing argument(s)' },
  'fix rigid/nve/small': { p: 3, pos: ['molecule|custom:bodystyle'], min: 4, minMsg: 'Illegal fix rigid/nve/small command: missing argument(s)', kw: 'langevin=num,num,num,int infile=file reinit=bool mol=word temp=num,num,num iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none dilate=word tparam=int,int,int pchain=int gravity=word', unknown: 'Unknown fix rigid/nve/small keyword {kw}', missing: 'Illegal fix rigid/nve/small {kw} command' },
  'fix rigid/nvt': { p: 3, pos: ['single|molecule|custom|group:bodystyle'], min: 4, minMsg: 'Illegal fix rigid/nvt command: missing argument(s)', kw: 'force=word,on|off,on|off,on|off torque=word,on|off,on|off,on|off langevin=num,num,num,int temp=num,num,num iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none dilate=word tparam=int,int,int pchain=int infile=file reinit=bool gravity=word', unknown: 'Illegal fix rigid/nvt command', missing: 'Illegal fix rigid/nvt {kw} command: missing argument(s)' },
  'fix rigid/nvt/small': { p: 3, pos: ['molecule|custom:bodystyle'], min: 4, minMsg: 'Illegal fix rigid/nvt/small command: missing argument(s)', kw: 'langevin=num,num,num,int infile=file reinit=bool mol=word temp=num,num,num iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none dilate=word tparam=int,int,int pchain=int gravity=word', unknown: 'Unknown fix rigid/nvt/small keyword {kw}', missing: 'Illegal fix rigid/nvt/small {kw} command' },
  'fix rigid/small': { p: 3, pos: ['molecule|custom:bodystyle'], min: 4, minMsg: 'Illegal fix rigid/small command: missing argument(s)', kw: 'langevin=num,num,num,int infile=file reinit=bool mol=word temp=num,num,num iso=num,num,num aniso=num,num,num x=num,num,num y=num,num,num z=num,num,num couple=xyz|xy|yz|xz|none dilate=word tparam=int,int,int pchain=int gravity=word', unknown: 'Unknown fix rigid/small keyword {kw}', missing: 'Illegal fix rigid/small {kw} command' },
  'fix setforce': { p: 3, pos: ['numvar:fx|NULL', 'numvar:fy|NULL', 'numvar:fz|NULL'], minMsg: 'Illegal fix setforce command: missing argument(s)', kw: 'region=word', unknown: 'Unknown fix setforce keyword: {kw}', missing: 'Illegal fix setforce region command: missing argument(s)' },
  'fix shake': { p: 3, pos: ['num:tol', 'int:iter', 'int:N'], min: 8, minMsg: 'Illegal fix shake command: missing argument(s)', kw: 'mol=word kbond=num', unknown: 'Unknown fix shake command option: {kw}', missing: 'Illegal fix shake {kw} command: missing argument(s)' },
  'fix smd': { p: 3, pos: ['cvel|cfor:mode'], minMsg: 'Illegal fix smd command', unknown: 'Illegal fix smd command', missing: 'Illegal fix smd command' },
  'fix spring': { p: 3, pos: ['tether|couple:mode'], min: 9, minMsg: 'Illegal fix spring command' },
  'fix spring/rg': { p: 3, pos: ['num:K', 'num:RG0'], minMsg: 'Illegal fix spring/rg command', unknown: 'Illegal fix spring/rg command', missing: 'Illegal fix spring/rg command' },
  'fix spring/self': { p: 3, pos: [['num:K', '> 0', 'Illegal fix spring/self command'], '?xyz|xy|xz|yz|x|y|z:dims'], min: 4, minMsg: 'Illegal fix spring/self command', max: 5, maxMsg: 'Illegal fix spring/self command' },
  'fix store/state': { p: 3, pos: [['int:N', '>= 0', 'Invalid fix store/state never value {N}']], min: 5, minMsg: 'Illegal fix store/state command: missing argument(s)', kw: 'com=bool', unknown: 'Unknown fix store/state keyword: {kw}', missing: 'Illegal fix store/state com command: missing argument(s)' },
  'fix temp/berendsen': { p: 3, pos: ['numvar:Tstart', 'num:Tstop', ['num:Tdamp', '> 0', 'Fix temp/berendsen Tdamp period must be > 0.0']], minMsg: 'Illegal fix temp/berendsen command: expected 6 arguments but found {narg}', max: 6, maxMsg: 'Illegal fix temp/berendsen command: expected 6 arguments but found {narg}' },
  'fix temp/csld': { p: 3, pos: ['numvar:Tstart', 'num:Tstop', ['num:Tdamp', '> 0', 'Illegal fix temp/csld command'], ['int:seed', '> 0', 'Illegal fix temp/csld  command']], minMsg: 'Illegal fix temp/csld command', max: 7, maxMsg: 'Illegal fix temp/csld command' },
  'fix temp/csvr': { p: 3, pos: ['numvar:Tstart', 'num:Tstop', ['num:Tdamp', '> 0', 'Illegal fix temp/csvr command'], ['int:seed', '> 0', 'Illegal fix temp/csvr command']], minMsg: 'Illegal fix temp/csvr command', max: 7, maxMsg: 'Illegal fix temp/csvr command' },
  'fix temp/rescale': { p: 3, pos: [['int:N', '> 0', 'Invalid fix temp/rescale every argument: {val}'], 'numvar:Tstart', ['num:Tstop', '>= 0', 'Invalid fix temp/rescale Tstop argument: {val}'], ['num:window', '>= 0', 'Invalid fix temp/rescale window argument: {val}'], ['num:fraction', '> 0', 'Invalid fix temp/rescale fraction argument: {val}']], minMsg: 'Illegal fix temp/rescale command: missing argument(s)' },
  'fix tgnvt/drude': { p: 3, min: 4, minMsg: 'Illegal fix tgnvt/drude command', kw: 'temp=num,num,num,num,num iso=num,num,num aniso=num,num,num tri=num,num,num x=num,num,num y=num,num,num z=num,num,num xy=num,num,num xz=num,num,num yz=num,num,num couple=xyz|xy|yz|xz|none tchain=int pchain=int mtk=bool tloop=int ploop=int nreset=int scalexy=bool scalexz=bool scaleyz=bool flip=bool fixedpoint=num,num,num', unknown: 'Illegal fix nvt/npt/nph command', missing: 'Illegal fix nvt/npt/nph command' },
  'fix tmd': { p: 3, pos: [['num:rho_final', '>= 0', 'Illegal fix tmd command'], 'file:target_file', ['int:Nevery', '>= 0', 'Illegal fix tmd command']], min: 6, minMsg: 'Illegal fix tmd command', unknown: 'Illegal fix tmd command', missing: 'Illegal fix tmd command' },
  'fix ttm': { p: 3, pos: ['int:seed', 'num:C_e', 'num:rho_e', 'num:kappa_e', 'num:gamma_p', 'num:gamma_s', 'num:v_0', 'int:Nx', 'int:Ny', 'int:Nz'], min: 13, minMsg: 'Illegal fix ttm command', kw: 'set=num infile=file outfile=int,file', unknown: 'Illegal fix ttm command', missing: 'Illegal fix ttm command' },
  'fix viscous': { p: 3, pos: ['num:gamma'], minMsg: 'Illegal fix viscous command', kw: 'scale=int,num', unknown: 'Illegal fix viscous command', missing: 'Illegal fix viscous command' },
  'fix wall/harmonic': { p: 3, kw: 'xlo=word,word,word,word xhi=word,word,word,word ylo=word,word,word,word yhi=word,word,word,word zlo=word,word,word,word zhi=word,word,word,word units=box|lattice fld=bool pbc=bool', unknown: 'Illegal fix wall/harmonic command', missing: 'Missing argument for fix wall/harmonic command' },
  'fix wall/lj1043': { p: 3, kw: 'xlo=word,word,word,word xhi=word,word,word,word ylo=word,word,word,word yhi=word,word,word,word zlo=word,word,word,word zhi=word,word,word,word units=box|lattice fld=bool pbc=bool', unknown: 'Illegal fix wall/lj1043 command', missing: 'Missing argument for fix wall/lj1043 command' },
  'fix wall/lj126': { p: 3, kw: 'xlo=word,word,word,word xhi=word,word,word,word ylo=word,word,word,word yhi=word,word,word,word zlo=word,word,word,word zhi=word,word,word,word units=box|lattice fld=bool pbc=bool', unknown: 'Illegal fix wall/lj126 command', missing: 'Missing argument for fix wall/lj126 command' },
  'fix wall/lj93': { p: 3, kw: 'xlo=word,word,word,word xhi=word,word,word,word ylo=word,word,word,word yhi=word,word,word,word zlo=word,word,word,word zhi=word,word,word,word units=box|lattice fld=bool pbc=bool', unknown: 'Illegal fix wall/lj93 command', missing: 'Missing argument for fix wall/lj93 command' },
  'fix wall/morse': { p: 3, kw: 'xlo=word,word,word,word,word xhi=word,word,word,word,word ylo=word,word,word,word,word yhi=word,word,word,word,word zlo=word,word,word,word,word zhi=word,word,word,word,word units=box|lattice fld=bool pbc=bool', unknown: 'Illegal fix wall/morse command', missing: 'Missing argument for fix wall/morse command' },
  'fix wall/reflect': { p: 3, min: 4, minMsg: 'Illegal fix wall/reflect command: missing argument(s)', kw: 'xlo=word xhi=word ylo=word yhi=word zlo=word zhi=word units=box|lattice', unknown: 'Unknown fix wall/reflect keyword: {kw}', missing: 'Illegal fix wall/reflect {kw} command: missing argument(s)' },
  'group': { p: 0, pos: ['word', 'region|empty|type|molecule|id|variable|include|subtract|union|intersect|dynamic|static|delete|clear'], minMsg: 'Illegal group command: missing argument(s)' },
  'group clear': { p: 2 },
  'group delete': { p: 2 },
  'group dynamic': { p: 2, pos: ['group'], min: 4, minMsg: 'Illegal group command', kw: 'region=word var=word property=word every=int', unknown: 'Unknown keyword {kw} in dynamic group command', missing: 'Illegal group dynamic {kw} command: missing argument(s)' },
  'group empty': { p: 2 },
  'group id': { p: 2, pos: ['rest'], minMsg: 'Illegal group id command: missing argument(s)' },
  'group include': { p: 2, pos: ['molecule'], minMsg: 'Illegal group include command' },
  'group intersect': { p: 2, pos: ['group', 'group'], minMsg: 'Illegal group intersect command: missing argument(s)' },
  'group molecule': { p: 2, pos: ['rest'], minMsg: 'Illegal group molecule command: missing argument(s)' },
  'group region': { p: 2, pos: ['word'], minMsg: 'Illegal group region command' },
  'group static': { p: 2 },
  'group subtract': { p: 2, pos: ['group', 'group'], minMsg: 'Illegal group subtract command: missing argument(s)' },
  'group type': { p: 2, pos: ['rest'], minMsg: 'Illegal group type command: missing argument(s)' },
  'group union': { p: 2, pos: ['group'], minMsg: 'Illegal group union command: missing argument(s)' },
  'group variable': { p: 2, pos: ['word'] },
  'improper_coeff': { p: 0, pos: ['type:improper'] },
  'improper_coeff class2': { p: 1, pos: ['num:K', 'num:chi0'], min: 2, minMsg: 'Incorrect args for improper coefficients' },
  'improper_coeff cossq': { p: 1, pos: ['num:K', 'num:chi0'], minMsg: 'Incorrect args for cossq improper coefficients' },
  'improper_coeff cvff': { p: 1, pos: ['num:K', 'int:d', 'int:n'], minMsg: 'Incorrect args for improper coefficients' },
  'improper_coeff distance': { p: 1, pos: ['num:K2', 'num:K4'], minMsg: 'Incorrect args for improper coefficients' },
  'improper_coeff fourier': { p: 1, pos: ['num:K', 'num:C0', 'num:C1', 'num:C2', '?int:all'], minMsg: 'Incorrect args for improper coefficients' },
  'improper_coeff harmonic': { p: 1, pos: ['num:K', 'num:chi'], minMsg: 'Incorrect args for improper coefficients' },
  'improper_coeff hybrid': { p: 1, pos: ['word:sub-style', 'rest:sub-style'] },
  'improper_coeff ring': { p: 1, pos: ['num:K', 'num:theta0'], minMsg: 'Incorrect args for RING improper coefficients' },
  'improper_coeff umbrella': { p: 1, pos: ['num:K', 'num:omega0'], minMsg: 'Incorrect args for improper coefficients' },
  'improper_coeff zero': { p: 1 },
  'improper_style': { p: 0, pos: ['word:style'], minMsg: 'Illegal improper_style command' },
  'improper_style class2': { p: 1 },
  'improper_style cossq': { p: 1 },
  'improper_style cvff': { p: 1 },
  'improper_style distance': { p: 1 },
  'improper_style fourier': { p: 1 },
  'improper_style harmonic': { p: 1 },
  'improper_style hybrid': { p: 1, pos: ['rest:sub-styles'], minMsg: 'Illegal improper_style hybrid command: missing argument(s)' },
  'improper_style ring': { p: 1 },
  'improper_style umbrella': { p: 1 },
  'improper_style zero': { p: 1, kw: 'nocoeff=' },
  'info': { p: 0, kw: 'all= communication= computes= dumps= fixes= groups= regions= config= time= memory= variables= system= coeffs= accelerator= fft= styles=all|atom|integrate|minimize|pair|bond|angle|dihedral|improper|kspace|fix|compute|region|dump|command out=screen|log|append|overwrite' },
  'kspace_modify': { p: 0, kw: 'mesh=int,int,int mesh/disp=int,int,int order=int order/disp=int minorder=int overlap=bool force=num gewald=num gewald/disp=num slab=word wire=word amat=onestep|twostep compute=bool fftbench=bool collective=bool diff=ad|ik cutoff/adjust=bool kmax/ewald=int,int,int mix/disp=pair|geom|none force/disp/real=num force/disp/kspace=num eigtol=num pressure/scalar=bool disp/auto=bool', unknown: 'Illegal kspace_modify command', missing: 'Illegal kspace_modify command' },
  'kspace_style': { p: 0, pos: ['word:style'] },
  'kspace_style ewald': { p: 1, pos: ['num:accuracy'], minMsg: 'Illegal kspace_style ewald command' },
  'kspace_style ewald/dipole': { p: 1, pos: ['num:accuracy'], minMsg: 'Illegal kspace_style ewald/dipole command' },
  'kspace_style ewald/disp': { p: 1, pos: ['num:accuracy'], minMsg: 'Illegal kspace_style ewald/disp command' },
  'kspace_style msm': { p: 1, pos: ['num:accuracy'], minMsg: 'Illegal kspace_style msm command' },
  'kspace_style msm/cg': { p: 1, pos: ['num:accuracy', '?num:smallq'], minMsg: 'Illegal kspace_style msm/cg command' },
  'kspace_style pppm': { p: 1, pos: ['num:accuracy'], minMsg: 'Illegal kspace_style pppm command' },
  'kspace_style pppm/cg': { p: 1, pos: ['num:accuracy', '?num:smallq'], minMsg: 'Illegal kspace_style pppm/cg command' },
  'kspace_style pppm/dipole': { p: 1, pos: ['num:accuracy'], minMsg: 'Illegal kspace_style pppm/dipole command' },
  'kspace_style pppm/disp': { p: 1, pos: ['num:accuracy'], minMsg: 'Illegal kspace_style pppm/disp command' },
  'kspace_style pppm/disp/tip4p': { p: 1, pos: ['num:accuracy'], minMsg: 'Illegal kspace_style pppm/disp/tip4p command' },
  'kspace_style pppm/stagger': { p: 1, pos: ['num:accuracy'], minMsg: 'Illegal kspace_style pppm/stagger command' },
  'kspace_style pppm/tip4p': { p: 1, pos: ['num:accuracy'], minMsg: 'Illegal kspace_style pppm/tip4p command' },
  'labelmap': { p: 0, pos: ['atom|bond|angle|dihedral|improper|clear|write'], minMsg: 'Incorrect number of arguments for labelmap command' },
  'lattice': { p: 0, pos: ['none|sc|bcc|fcc|hcp|diamond|sq|sq2|hex|custom', ['num:scale', '> 0', 'Invalid lattice {style} argument: {word}']], minMsg: 'Illegal lattice command: missing argument(s)', kw: 'origin=num,num,num orient=x|y|z,int,int,int spacing=num,num,num a1=num,num,num a2=num,num,num a3=num,num,num basis=num,num,num triclinic/general=', unknown: 'Unknown lattice keyword: {kw}', missing: 'Illegal lattice {kw} command: missing argument(s)' },
  'mass': { p: 0, pos: ['type', ['num:mass', '> 0', 'Invalid atom mass value {value} for type {word}']], minMsg: 'Illegal mass command: expected 2 arguments but found {n}' },
  'min_modify': { p: 0, min: 1, minMsg: 'Illegal min_modify command', kw: 'dmax=num delaystep=num dtgrow=num dtshrink=num alpha0=num alphashrink=num tmax=num tmin=num halfstepback=bool initialdelay=bool vdfmax=num integrator=eulerimplicit|verlet|leapfrog|eulerexplicit abcfire=bool line=backtrack|quadratic|forcezero|spin_cubic|spin_none norm=two|max|inf', unknown: 'Illegal fix_modify command', missing: 'Illegal min_modify command' },
  'min_style': { p: 0, pos: ['cg|hftn|sd|quickmin|fire|fire/old|DEPRECATED|spin|spin/cg|spin/lbfgs:style'], minMsg: 'Illegal minimize_style command' },
  'min_style cg': { p: 1 },
  'min_style fire': { p: 1 },
  'min_style fire/old': { p: 1 },
  'min_style hftn': { p: 1 },
  'min_style quickmin': { p: 1 },
  'min_style sd': { p: 1 },
  'minimize': { p: 0, pos: [['num:etol', '>= 0', 'Illegal minimize energy tolerance: {value}'], ['num:ftol', '>= 0', 'Illegal minimize force tolerance: {value}'], 'int:maxiter', 'int:maxeval'], minMsg: 'Illegal minimize command: expected 4 arguments but found {n}', unknown: 'Illegal minimize command: expected 4 arguments but found {n}' },
  'neigh_modify': { p: 0, kw: 'every=int delay=int check=bool once=bool page=int one=int binsize=num cluster=bool include=group exclude=*exclude collection/interval=int,rest collection/type=int,rest', unknown: 'Unknown neigh_modify keyword: {kw}', missing: 'Illegal neigh_modify {kw} command: missing argument(s)' },
  'neighbor': { p: 0, pos: [['num:skin', '>= 0', 'Invalid neighbor argument: {word}'], 'bin|nsq|multi|multi/old'], minMsg: 'Illegal neighbor command: expected 2 arguments but found {n}' },
  'newton': { p: 0, pos: ['bool:pair', '?bool:bond'], minMsg: 'Illegal newton command' },
  'package': { p: 0, pos: ['omp|gpu|kokkos|intel'], minMsg: 'Illegal package command' },
  'package omp': { p: 1, pos: ['int:Nthreads'], minMsg: 'Illegal package omp command', kw: 'neigh=bool', unknown: 'Illegal package omp command', missing: 'Illegal package omp command' },
  'pair_modify': { p: 0, min: 1, minMsg: 'Illegal pair_modify command: missing argument(s)', kw: 'mix=geometric|arithmetic|sixthpower shift=bool table=int table/disp=int tabinner=num tabinner/disp=num tail=bool compute=bool nofdotr= neigh/trim=bool pair=word special=lj/coul|lj|coul,num,num,num compute/tally=bool', unknown: 'Unknown pair_modify keyword: {kw}', missing: 'Illegal pair_modify {kw} command: missing argument(s)' },
  'processors': { p: 0, pos: ['int:Px|*', 'int:Py|*', 'int:Pz|*'], minMsg: 'Illegal processors command', kw: 'grid=onelevel|twolevel|numa|custom map=cart|cart/reorder|xyz|xzy|yxz|yzx|zxy|zyx part=int,int,multiple file=file numa_nodes=int', unknown: 'Illegal processors command', missing: 'Illegal processors command' },
  'read_data': { p: 0, pos: ['file:file'], minMsg: 'Illegal read_data command: missing argument(s)', kw: 'add=word offset=int,int,int,int,int shift=num,num,num nocoeff= extra/atom/types=int extra/bond/types=int extra/angle/types=int extra/dihedral/types=int extra/improper/types=int extra/bond/per/atom=int extra/angle/per/atom=int extra/dihedral/per/atom=int extra/improper/per/atom=int extra/special/per/atom=int group=word fix=word,word,word', unknown: 'Unknown read_data keyword {kw}', missing: 'Illegal read_data {kw} command: missing argument(s)' },
  'read_restart': { p: 0, pos: ['file:file'], minMsg: 'Illegal read_restart command', kw: 'noremap= remap=', unknown: 'Illegal read_restart command' },
  'region': { p: 0, pos: ['word', 'block|cone|cylinder|ellipsoid|intersect|plane|prism|sphere|union|delete'], minMsg: 'Illegal region command: missing argument(s)', kw: 'side=in|out units=box|lattice move=word,word,word rotate=word,num,num,num,num,num,num open=int', unknown: 'Illegal region command argument: {kw}', missing: 'Illegal region {kw} command: missing argument(s)' },
  'region block': { p: 2, pos: ['numvar:xlo|INF|EDGE', 'numvar:xhi|INF|EDGE', 'numvar:ylo|INF|EDGE', 'numvar:yhi|INF|EDGE', 'numvar:zlo|INF|EDGE', 'numvar:zhi|INF|EDGE'], minMsg: 'Illegal region command: missing argument(s)', kw: 'side=in|out units=box|lattice move=word,word,word rotate=word,num,num,num,num,num,num open=int', unknown: 'Illegal region command argument: {kw}', missing: 'Illegal region {kw} command: missing argument(s)' },
  'region cone': { p: 2, pos: ['x|y|z', 'numvar:c1', 'numvar:c2', 'numvar:radlo', 'numvar:radhi', 'numvar:lo|INF|EDGE', 'numvar:hi|INF|EDGE'], minMsg: 'Illegal region command: missing argument(s)', kw: 'side=in|out units=box|lattice move=word,word,word rotate=word,num,num,num,num,num,num open=int', unknown: 'Illegal region command argument: {kw}', missing: 'Illegal region {kw} command: missing argument(s)' },
  'region cylinder': { p: 2, pos: ['x|y|z', 'numvar:c1', 'numvar:c2', 'numvar:radius', 'num:lo|INF|EDGE', 'num:hi|INF|EDGE'], minMsg: 'Illegal region command: missing argument(s)', kw: 'side=in|out units=box|lattice move=word,word,word rotate=word,num,num,num,num,num,num open=int', unknown: 'Illegal region command argument: {kw}', missing: 'Illegal region {kw} command: missing argument(s)' },
  'region ellipsoid': { p: 2, pos: ['numvar:x', 'numvar:y', 'numvar:z', 'numvar:a', 'numvar:b', 'numvar:c'], minMsg: 'Illegal region command: missing argument(s)', kw: 'side=in|out units=box|lattice move=word,word,word rotate=word,num,num,num,num,num,num open=int', unknown: 'Illegal region command argument: {kw}', missing: 'Illegal region {kw} command: missing argument(s)' },
  'region intersect': { p: 2, pos: ['int:N', 'rest'], min: 5, minMsg: 'Illegal region intersect command: missing argument(s)', kw: 'side=in|out units=box|lattice move=word,word,word rotate=word,num,num,num,num,num,num open=int', unknown: 'Illegal region command argument: {kw}', missing: 'Illegal region {kw} command: missing argument(s)' },
  'region plane': { p: 2, pos: ['num', 'num', 'num', 'num', 'num', 'num'], minMsg: 'Illegal region command: missing argument(s)', kw: 'side=in|out units=box|lattice move=word,word,word rotate=word,num,num,num,num,num,num open=int', unknown: 'Illegal region command argument: {kw}', missing: 'Illegal region {kw} command: missing argument(s)' },
  'region prism': { p: 2, pos: ['num:xlo|INF|EDGE', 'num:xhi|INF|EDGE', 'num:ylo|INF|EDGE', 'num:yhi|INF|EDGE', 'num:zlo|INF|EDGE', 'num:zhi|INF|EDGE', 'num', 'num', 'num'], minMsg: 'Illegal region command: missing argument(s)', kw: 'side=in|out units=box|lattice move=word,word,word rotate=word,num,num,num,num,num,num open=int', unknown: 'Illegal region command argument: {kw}', missing: 'Illegal region {kw} command: missing argument(s)' },
  'region sphere': { p: 2, pos: ['numvar:x', 'numvar:y', 'numvar:z', 'numvar:radius'], minMsg: 'Illegal region command: missing argument(s)', kw: 'side=in|out units=box|lattice move=word,word,word rotate=word,num,num,num,num,num,num open=int', unknown: 'Illegal region command argument: {kw}', missing: 'Illegal region {kw} command: missing argument(s)' },
  'region union': { p: 2, pos: ['int:N', 'rest'], min: 5, minMsg: 'Illegal region union command: missing argument(s)', kw: 'side=in|out units=box|lattice move=word,word,word rotate=word,num,num,num,num,num,num open=int', unknown: 'Illegal region command argument: {kw}', missing: 'Illegal region {kw} command: missing argument(s)' },
  'replicate': { p: 0, pos: ['int', 'int', 'int'], minMsg: 'Illegal replicate command', kw: 'bbox= bond/periodic=', unknown: 'Illegal replicate command' },
  'rerun': { p: 0, pos: ['file:file1'], min: 2, minMsg: 'Illegal rerun command', kw: 'first=bigint last=bigint every=int skip=int start=bigint stop=bigint post=bool dump=rest', unknown: 'Illegal rerun command', missing: 'Illegal rerun command' },
  'reset_atoms': { p: 0, pos: ['id|mol|image'] },
  'reset_atoms id': { p: 1, kw: 'sort=bool', unknown: 'Unknown reset_atoms id keyword: {kw}', missing: 'Illegal reset_atoms id command: missing argument(s)' },
  'reset_atoms image': { p: 1, pos: ['group'], minMsg: 'Illegal reset_atoms image command: missing argument(s)' },
  'reset_atoms mol': { p: 1, pos: ['group'], minMsg: 'Illegal reset_atoms mol command: missing argument(s)', kw: 'compress=bool single=bool offset=tagint', unknown: 'Unknown reset_atoms mol keyword: {kw}', missing: 'Illegal reset_atoms mol {kw} command: missing argument(s)' },
  'reset_timestep': { p: 0, pos: [['bigint:N', '>= 0', 'Timestep must be >= 0']], minMsg: 'Illegal reset_timestep command: missing argument(s)', kw: 'time=num', unknown: 'Unknown reset_timestep option {kw}', missing: 'Illegal reset_timestep time command: missing argument(s)' },
  'restart': { p: 0, pos: ['numvar:N', 'file:file1'], min: 1, minMsg: 'Illegal restart command: missing argument(s)', kw: 'fileper=int nfile=int noinit=', unknown: 'Unknown write_restart keyword: {kw}', missing: 'Illegal write_restart command: missing argument(s)' },
  'run': { p: 0, pos: ['bigint:N'], minMsg: 'Illegal run command: missing argument(s)', kw: 'upto= start=bigint stop=bigint pre=bool post=bool every=int,rest', unknown: 'Unknown run keyword: {kw}', missing: 'Illegal run {kw} command: missing argument(s)' },
  'run_style': { p: 0, pos: ['verlet|respa|respa/omp|verlet/split|verlet/kk|verlet/lrt/intel:style'], minMsg: 'Illegal run_style command' },
  'run_style respa': { p: 1, pos: [['int:N', '>= 1', 'Respa levels must be >= 1'], ['int:loop1..loop(N-1)', '> 0', 'Illegal run_style respa command']], minMsg: 'Illegal run_style respa command', kw: 'bond=int angle=int dihedral=int improper=int pair=int inner=int,num,num middle=int,num,num outer=int kspace=int hybrid=rest', unknown: 'Illegal run_style respa command', missing: 'Illegal run_style respa command' },
  'run_style verlet': { p: 1 },
  'set': { p: 0, pos: ['atom|type|mol|group|region', 'word'], min: 4, minMsg: 'Illegal set command: need at least four arguments', unknown: 'Set keyword or custom property {name} does not exist', missing: 'Illegal set {kw} command: missing argument(s)' },
  'special_bonds': { p: 0, min: 1, minMsg: 'Illegal special_bonds command', kw: 'amber= charmm= dreiding= fene= lj/coul=num,num,num lj=num,num,num coul=num,num,num angle=bool dihedral=bool one/five=yes|no', unknown: 'Illegal special_bonds command', missing: 'Illegal special_bonds command' },
  'suffix': { p: 0, pos: ['word'], minMsg: 'Illegal suffix command' },
  'thermo': { p: 0, pos: [['numvar:N', '>= 0', 'Illegal thermo output frequency {value}']], minMsg: 'Illegal thermo command', unknown: 'Illegal thermo command' },
  'thermo_modify': { p: 0, min: 1, minMsg: 'Illegal thermo_modify command: missing argument(s)', kw: 'temp=word press=word triclinic/general=bool lost=ignore|warn|error lost/bond=ignore|warn|error warn=word norm=bool flush=bool line=one|multi|yaml colname=word,word format=word,word', unknown: 'Unknown thermo_modify keyword: {kw}', missing: 'Illegal thermo_modify {kw} command: missing argument(s)' },
  'thermo_style': { p: 0, pos: ['one|multi|yaml|custom:style'], minMsg: 'Illegal thermo_style command: missing argument(s)' },
  'thermo_style custom': { p: 1, min: 2, minMsg: 'Illegal thermo style custom command', kw: 'step= elapsed= elaplong= dt= time= cpu= tpcpu= spcpu= cpuremain= part= timeremain= atoms= temp= press= pe= ke= etotal= evdwl= ecoul= epair= ebond= eangle= edihed= eimp= emol= elong= etail= enthalpy= ecouple= econserve= vol= density= lx= ly= lz= xlo= xhi= ylo= yhi= zlo= zhi= xy= xz= yz= avecx= avecy= avecz= bvecx= bvecy= bvecz= cvecx= cvecy= cvecz= xlat= ylat= zlat= cella= cellb= cellc= cellalpha= cellbeta= cellgamma= pxx= pyy= pzz= pxy= pxz= pyz= bonds= angles= dihedrals= impropers= fmax= fnorm= nbuild= ndanger=', unknown: 'Unknown keyword \'{kw}\' in thermo_style custom command' },
  'timestep': { p: 0, pos: ['num:dt'], minMsg: 'Illegal timestep command', unknown: 'Illegal timestep command' },
  'uncompute': { p: 0, pos: ['word:ID'], minMsg: 'Illegal uncompute command' },
  'undump': { p: 0, pos: ['word:dump-ID'], minMsg: 'Illegal undump command', unknown: 'Illegal undump command' },
  'units': { p: 0, pos: ['lj|real|metal|si|cgs|electron|micro|nano'], minMsg: 'Illegal units command: expected 1 argument but found {n}' },
  'velocity': { p: 0, pos: ['group:group-ID', 'create|set|scale|ramp|zero:style'], minMsg: 'Illegal velocity command: missing argument(s)', kw: 'dist=uniform|gaussian sum=bool mom=bool rot=bool temp=word bias=bool loop=all|local|geom rigid=word units=box|lattice', unknown: 'Unknown velocity keyword: {kw}', missing: 'Illegal velocity {kw} command: missing argument(s)' },
  'velocity create': { p: 2, pos: ['num:temp', ['int:seed', '> 0', 'Illegal velocity create seed argument: {value}']], min: 4, minMsg: 'Illegal velocity command: missing argument(s)', kw: 'dist=uniform|gaussian sum=bool mom=bool rot=bool temp=word bias=bool loop=all|local|geom rigid=word units=box|lattice', unknown: 'Unknown velocity keyword: {kw}', missing: 'Illegal velocity {kw} command: missing argument(s)' },
  'velocity ramp': { p: 2, pos: ['vx|vy|vz:vdim', 'num:vlo', 'num:vhi', 'x|y|z:dim', 'num:clo', 'num:chi'], min: 8, minMsg: 'Illegal velocity command: missing argument(s)', kw: 'dist=uniform|gaussian sum=bool mom=bool rot=bool temp=word bias=bool loop=all|local|geom rigid=word units=box|lattice', unknown: 'Unknown velocity keyword: {kw}', missing: 'Illegal velocity {kw} command: missing argument(s)' },
  'velocity scale': { p: 2, pos: ['num:temp'], min: 3, minMsg: 'Illegal velocity command: missing argument(s)', kw: 'dist=uniform|gaussian sum=bool mom=bool rot=bool temp=word bias=bool loop=all|local|geom rigid=word units=box|lattice', unknown: 'Unknown velocity keyword: {kw}', missing: 'Illegal velocity {kw} command: missing argument(s)' },
  'velocity set': { p: 2, pos: ['numvar:vx|NULL', 'numvar:vy|NULL', 'numvar:vz|NULL'], min: 5, minMsg: 'Illegal velocity command: missing argument(s)', kw: 'dist=uniform|gaussian sum=bool mom=bool rot=bool temp=word bias=bool loop=all|local|geom rigid=word units=box|lattice', unknown: 'Unknown velocity keyword: {kw}', missing: 'Illegal velocity {kw} command: missing argument(s)' },
  'velocity zero': { p: 2, pos: ['linear|angular:which'], min: 3, minMsg: 'Illegal velocity command: missing argument(s)', kw: 'dist=uniform|gaussian sum=bool mom=bool rot=bool temp=word bias=bool loop=all|local|geom rigid=word units=box|lattice', unknown: 'Unknown velocity keyword: {kw}', missing: 'Illegal velocity {kw} command: missing argument(s)' },
  'write_coeff': { p: 0, pos: ['file'], minMsg: 'Illegal write_coeff command: missing argument(s)' },
  'write_data': { p: 0, pos: ['file:file'], minMsg: 'Illegal write_data command: missing argument(s)', kw: 'pair=ii|ij noinit= nocoeff= nofix= triclinic/general= nolabelmap= types=numeric|labels', unknown: 'Unknown write_data keyword: {kw}', missing: 'Illegal write_data {kw} command: missing argument(s)' },
  'write_dump': { p: 0, pos: ['group:group-ID', 'word:style', 'file:file'], min: 3, minMsg: 'Illegal write_dump command: missing argument(s)' },
  'write_restart': { p: 0, pos: ['file:file'], minMsg: 'Illegal write_restart command: missing argument(s)', kw: 'fileper=int nfile=int noinit=', unknown: 'Unknown write_restart keyword: {kw}', missing: 'Illegal write_restart command: missing argument(s)' }
,
  'fix imd': { p: 3, pos: ['int:port'], minMsg: 'Illegal fix imd command', kw: 'unwrap=bool nowait=bool fscale=num trate=int', unknown: 'Unknown fix imd parameter', missing: 'Unknown fix imd parameter' }
};

/*
 * Pair styles: s = numbers of settings words allowed after the style name,
 * st = their types, c = numbers of pair_coeff words after the two types
 * ('ntypes' = a file then one element per type), ct = their types, cm = the
 * message when the count is wrong, one = pair_coeff must be * *, k = what the
 * style leaves to kspace (ewald, pppm, msm, dispersion, tip4p), q = the
 * message when charges are missing, nomix = i,j cannot be mixed from i,i
 * and j,j, mb = a many-body potential read from a file.
 */
const PAIR_INFO = {
  'airebo': { s: [1, 3, 4], st: 'n i i n', sm: 'Illegal pair_style airebo command', c: 'ntypes', cm: 'Incorrect number of args for pair coefficient.', one: 1, mb: 1 },
  'beck': { s: [1], st: 'n', c: [5, 6], ct: 'n n n n n n', nomix: 1 },
  'bop': { c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'born': { s: [1], st: 'n', c: [5, 6], ct: 'n n n n n n', nomix: 1 },
  'born/coul/long': { s: [1, 2], st: 'n n', c: [5, 6], ct: 'n n n n n n', k: 'ewald pppm', q: 'Pair style born/coul/long requires atom attribute q', nomix: 1 },
  'buck': { s: [1], st: 'n', c: [3, 4], ct: 'n n n n', nomix: 1 },
  'buck/coul/cut': { s: [1, 2], st: 'n n', c: [3, 4, 5], ct: 'n n n n n', q: 'Pair style buck/coul/cut requires atom attribute q', nomix: 1 },
  'buck/coul/long': { s: [1, 2], st: 'n n', c: [3, 4], ct: 'n n n n', k: 'ewald pppm', q: 'Pair style buck/coul/long requires atom attribute q', nomix: 1 },
  'buck/long/coul/long': { s: [3, 4], st: 'long|cut|off long|cut|off n n', c: [3, 4], ct: 'n n n n', k: 'ewald pppm dispersion', q: 'Invoking coulombic in pair style buck/long/coul/long requires atom attribute q', nomix: 1 },
  'comb': { s: [0], st: '', c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, q: 'Pair style COMB requires atom attribute q', mb: 1 },
  'comb3': { s: [1], st: 'polar_on|polar_off', c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, q: 'Pair style COMB3 requires atom attribute q', mb: 1 },
  'coul/cut': { s: [1], st: 'n', c: [0, 1], ct: 'n', q: 'Pair style coul/cut requires atom attribute q' },
  'coul/debye': { s: [2], st: 'n n', c: [0, 1], ct: 'n', q: 'Pair style coul/cut requires atom attribute q' },
  'coul/dsf': { s: [2], st: 'n n', c: [0], ct: '', q: 'Pair style coul/dsf requires atom attribute q' },
  'coul/long': { s: [1], st: 'n', c: [0], ct: '', k: 'ewald pppm', q: 'Pair style lj/cut/coul/long requires atom attribute q' },
  'coul/msm': { s: [1], st: 'n', c: [0], ct: '', k: 'msm', q: 'Pair style lj/cut/coul/long requires atom attribute q' },
  'coul/slater/long': { s: [2], st: 'n n', c: [0], ct: '', k: 'ewald pppm', q: 'Pair style coul/slater/long requires atom attribute q' },
  'coul/wolf': { s: [2], st: 'n n', c: [0], ct: '', q: 'Pair coul/wolf requires atom attribute q' },
  'eam': { s: [0], st: '', c: [1], ct: 'w', mb: 1 },
  'eam/alloy': { s: [0], st: '', c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'eam/cd': { s: [0], st: '', c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'eam/fs': { s: [0], st: '', c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'extep': { s: [0], st: '', c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'gauss': { s: [1], st: 'n', c: [2, 3], ct: 'n n n' },
  'gw': { s: [0], st: '', c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'hybrid': { cm: 'Illegal pair_coeff command: missing argument(s)' },
  'hybrid/overlay': {  },
  'hybrid/scaled': {  },
  'lcbop': { s: [0], st: '', c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'lj/charmm/coul/charmm': { s: [2, 4], st: 'n n n n', c: [2, 4], ct: 'n n n n', q: 'Pair style lj/charmm/coul/charmm requires atom attribute q' },
  'lj/charmm/coul/charmm/implicit': { s: [2, 4], st: 'n n n n', c: [2, 4], ct: 'n n n n', q: 'Pair style lj/charmm/coul/charmm requires atom attribute q' },
  'lj/charmm/coul/long': { s: [2, 3], st: 'n n n', c: [2, 4], ct: 'n n n n', cm: 'Illegal pair_coeff command', k: 'ewald pppm', q: 'Pair style lj/charmm/coul/long requires atom attribute q' },
  'lj/charmm/coul/msm': { s: [2, 3], st: 'n n n', c: [2, 4], ct: 'n n n n', cm: 'Illegal pair_coeff command', k: 'msm', q: 'Pair style lj/charmm/coul/long requires atom attribute q' },
  'lj/charmmfsw/coul/charmmfsh': { s: [2, 3], st: 'n n n', c: [2, 4], ct: 'n n n n', q: 'Pair style lj/charmmfsw/coul/charmmfsh requires atom attribute q' },
  'lj/charmmfsw/coul/long': { s: [2, 3], st: 'n n n', c: [2, 4], ct: 'n n n n', cm: 'Illegal pair_coeff command', k: 'ewald pppm', q: 'Pair style lj/charmmfsw/coul/long requires atom attribute q' },
  'lj/class2': { s: [1], st: 'n', c: [2, 3], ct: 'n n n' },
  'lj/class2/coul/cut': { s: [1, 2], st: 'n n', c: [2, 3, 4], ct: 'n n n n', q: 'Pair style lj/class2/coul/cut requires atom attribute q' },
  'lj/class2/coul/long': { s: [1, 2], st: 'n n', c: [2, 3], ct: 'n n n', k: 'ewald pppm', q: 'Pair style lj/class2/coul/long requires atom attribute q' },
  'lj/cubic': { s: [0], st: '', c: [2], ct: 'n n' },
  'lj/cut': { s: [1], st: 'n', c: [2, 3], ct: 'n n n' },
  'lj/cut/coul/cut': { s: [1, 2], st: 'n n', c: [2, 3, 4], ct: 'n n n n', q: 'Pair style lj/cut/coul/cut requires atom attribute q' },
  'lj/cut/coul/debye': { s: [2, 3], st: 'n n n', c: [2, 3, 4], ct: 'n n n n', q: 'Pair style lj/cut/coul/cut requires atom attribute q' },
  'lj/cut/coul/dsf': { s: [2, 3], st: 'n n n', c: [2, 3], ct: 'n n n', q: 'Pair style lj/cut/coul/dsf requires atom attribute q' },
  'lj/cut/coul/long': { s: [1, 2], st: 'n n', c: [2, 3], ct: 'n n n', k: 'ewald pppm', q: 'Pair style lj/cut/coul/long requires atom attribute q' },
  'lj/cut/coul/msm': { s: [1, 2], st: 'n n', c: [2, 3], ct: 'n n n', k: 'msm', q: 'Pair style lj/cut/coul/long requires atom attribute q' },
  'lj/cut/coul/wolf': { s: [2, 3], st: 'n n n', c: [2, 3], ct: 'n n n', q: 'Pair style lj/cut/coul/wolf requires atom attribute q' },
  'lj/cut/sphere': { s: [1], st: 'n', c: [1, 2], ct: 'n n' },
  'lj/cut/thole/long': { s: [2, 3], st: 'n n n', c: [3, 4, 5], ct: 'n n n n n', k: 'ewald pppm', q: 'Pair style lj/cut/thole/long requires atom attribute q' },
  'lj/cut/tip4p/cut': { s: [6, 7], st: 'w w w w n n n', c: [2, 3], ct: 'n n n', q: 'Pair style lj/cut/tip4p/cut requires atom attribute q' },
  'lj/cut/tip4p/long': { s: [6, 7], st: 'w w w w n n n', c: [2, 3], ct: 'n n n', k: 'ewald pppm tip4p', q: 'Pair style lj/cut/tip4p/long requires atom attribute q' },
  'lj/expand': { s: [1], st: 'n', c: [3, 4], ct: 'n n n n' },
  'lj/gromacs': { s: [2], st: 'n n', c: [2, 4], ct: 'n n n n' },
  'lj/gromacs/coul/gromacs': { s: [2, 4], st: 'n n n n', c: [2], ct: 'n n', q: 'Pair style lj/gromacs/coul/gromacs requires atom attribute q' },
  'lj/long/coul/long': { s: [3, 4], st: 'long|cut|off long|cut|off n n', c: [2, 3], ct: 'n n n', k: 'ewald pppm dispersion', q: 'Invoking coulombic in pair style lj/long/coul/long requires atom attribute q' },
  'lj/long/tip4p/long': { s: [8, 9], st: 'long|cut|off long|cut|off w w w w n n n', c: [2, 3], ct: 'n n n', k: 'ewald pppm tip4p dispersion', q: 'Pair style lj/long/tip4p/long requires atom attribute q' },
  'lj/mdf': { s: [2], st: 'n n', c: [2, 4], ct: 'n n n n' },
  'lj/relres': { s: [4], st: 'n n n n', c: [4, 8], ct: 'n n n n n n n n' },
  'lj/sf': { s: [1], st: 'n', c: [2, 3], ct: 'n n n' },
  'lj/smooth/linear': { s: [1], st: 'n', c: [2, 3], ct: 'n n n' },
  'lj96/cut': { s: [1], st: 'n', c: [2, 3], ct: 'n n n' },
  'meam': { s: [0], st: '', sm: 'Illegal pair_style meam command', cm: 'Incorrect args for pair style meam coefficients', one: 1, mb: 1 },
  'meam/spline': { s: [0], st: '', c: 'ntypes', one: 1, mb: 1 },
  'mie/cut': { s: [1], st: 'n', c: [4, 5], ct: 'n n n n n' },
  'morse': { s: [1], st: 'n', c: [3, 4], ct: 'n n n n', nomix: 1 },
  'nb3b/harmonic': { s: [0], st: '', c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'nm/cut': { s: [1], st: 'n', c: [4, 5], ct: 'n n n n n', nomix: 1 },
  'polymorphic': { s: [0], st: '', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'reaxff': { c: 'ntypes', one: 1, q: 'Pair style reaxff requires atom attribute q', mb: 1 },
  'rebo': { s: [0], st: '', c: 'ntypes', cm: 'Incorrect number of args for pair coefficient.', one: 1, mb: 1 },
  'soft': { s: [1], st: 'n', c: [1, 2], ct: 'n n' },
  'sw': { c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'table': { c: [2, 3], ct: 'w w n', cm: 'Illegal pair_coeff command', nomix: 1 },
  'tersoff': { c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'tersoff/mod': { c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'tersoff/zbl': { c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'thole': { s: [2], st: 'n n', c: [1, 2, 3], ct: 'n n n', q: 'Pair style thole requires atom attribute q' },
  'tip4p/cut': { s: [6], st: 'w w w w n n', c: [0], ct: '', q: 'Pair style tip4p/cut requires atom attribute q' },
  'tip4p/long': { s: [6], st: 'w w w w n n', c: [0], ct: '', k: 'ewald pppm tip4p', q: 'Pair style tip4p/long requires atom attribute q' },
  'ufm': { s: [1], st: 'n', c: [2, 3], ct: 'n n n' },
  'vashishta': { s: [0], st: '', c: 'ntypes', cm: 'Number of element to type mappings does not match number of atom types', one: 1, mb: 1 },
  'yukawa': { s: [2], st: 'n n', c: [1, 2], ct: 'n n' },
  'zbl': { s: [2], st: 'n n', c: [2], ct: 'n n' },
  'zero': {  }
};

/* ---- the commands input.cpp handles itself ---- */

Object.assign(Machine.prototype, {
  m_clear(args) {
    if (args.length) { this.error('bad-args', `Illegal clear command: unexpected arguments but found ${args.length}`); return; }
    this.reset();
  },

  m_echo(args) {
    if (args.length !== 1) { this.error('bad-args', `Illegal echo command: expected 1 argument but found ${args.length}`); return; }
    if (!['none', 'screen', 'log', 'both'].includes(args[0]) && !isUnknown(args[0])) this.error('bad-value', `Unknown echo keyword: ${args[0]}`, `echo takes none, screen, log or both; "${args[0]}" is none of them, so LAMMPS stops.`);
  },

  m_if(args) {
    if (args.length < 3) { this.missing('if'); return; }
    const cond = this.substitute(args[0]);
    if (cond === null) return;
    let test;
    try {
      test = evalBoolean(cond);
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      this.error('if-syntax', e.message, `LAMMPS cannot read the condition "${args[0]}" ("${e.message}"). ` +
        'An if condition compares numbers or words with == != < <= > >= and combines them with && ||; arithmetic needs $(...).', { url: page('if') });
      return;
    }
    if (args[1] !== 'then') { this.error('bad-args', `Illegal if command: expected "then" but found "${args[1]}"`, `if needs "then" after the condition; found "${args[1]}", so LAMMPS stops.`, { url: page('if') }); return; }
    // Split into branches: then cmds [elif cond cmds]... [else cmds]
    const branches = [];
    let i = 2;
    let current = { cond: test, cmds: [] };
    while (i < args.length) {
      const w = args[i];
      if (w === 'elif' || w === 'else') {
        branches.push(current);
        if (w === 'elif') {
          if (i + 2 > args.length) { this.missing('if then'); return; }
          current = { condText: args[i + 1], cmds: [] };
          i += 2;
        } else {
          current = { cond: true, cmds: [], isElse: true };
          i += 1;
        }
        continue;
      }
      current.cmds.push(w);
      i += 1;
    }
    branches.push(current);
    for (const b of branches) {
      if (b.condText !== undefined) {
        const t = this.substitute(b.condText);
        if (t === null) return;
        try { b.cond = evalBoolean(t); } catch (e) {
          if (!(e instanceof FormulaError)) throw e;
          this.error('if-syntax', e.message, `LAMMPS cannot read the condition "${b.condText}" ("${e.message}").`, { url: page('if') });
          return;
        }
      }
      if (b.cond === null) {
        // Only the run can tell which branch runs: check neither, and stop
        // trusting "not defined" errors from here on.
        this.st.uncertain = true;
        this.note('if-unknown', 'STEMKit cannot tell whether this condition holds (it depends on the run or the environment), ' +
          'so the commands it would run are not checked.', { url: page('if') });
        return;
      }
      if (!b.cond) continue;
      if (!b.cmds.length) { this.missing(b === branches[0] ? 'if then' : 'if elif/else'); return; }
      if (b.cmds.some(c => c === '')) { this.error('bad-args', `Illegal if ${b === branches[0] ? 'then' : 'elif/else'} command: execute command is empty`); return; }
      for (const c of b.cmds) this.exec(this.entry, c, true);
      return;
    }
  },

  m_include(args) {
    if (args.length !== 1) { this.error('bad-args', 'Illegal include command', 'include takes one file name, so LAMMPS stops ("Illegal include command").'); return; }
    const name = this.substitute(args[0]);
    if (name === null) return;
    this.openFile(name, 'include');
  },

  /* Follow `include` or `jump file` into a file given in options.files. */
  openFile(name, how) {
    if (isUnknown(name)) {
      this.st.uncertain = true;
      this.note('include-unknown', `The file name depends on the run, so STEMKit does not follow this ${how}.`);
      return how === 'jump' ? 'stop' : null;
    }
    const text = Object.prototype.hasOwnProperty.call(this.files, name) ? this.files[name] : null;
    if (text === null) {
      this.st.uncertain = true;
      this.note('include-missing', `${how === 'include' ? 'Reads commands from' : 'Continues with the commands of'} ${name}, which STEMKit was not given: ` +
        'its commands are not checked, and what it defines (styles, groups, fixes, variables) is assumed to exist.', { url: page(how) });
      return how === 'jump' ? 'stop' : null;
    }
    if (how === 'include' && this.frames.length >= 16) {
      this.error('include-depth', 'Too many nested levels of input scripts', 'Includes are nested more than 16 deep (an include loop?), so LAMMPS stops.');
      return null;
    }
    this.parsedFiles = this.parsedFiles || new Map();
    if (!this.parsedFiles.has(name)) {
      const p = parseInput(text);
      for (const l of p.lines) l.file = name;
      this.parsedFiles.set(name, p);
    }
    const lines = this.parsedFiles.get(name).lines;
    if (how === 'include') {
      const depth = this.frames.length;
      this.frames.push({ name, lines, pc: 0 });
      const saved = this.entry;
      this.runFrames(depth);
      this.entry = saved;
    } else {
      const f = this.frames[this.frames.length - 1];
      f.name = name; f.lines = lines; f.pc = 0;
    }
    return 'ok';
  },

  m_jump(args) {
    if (args.length < 1 || args.length > 2) { this.error('bad-args', `Illegal jump command: expected 1 or 2 argument(s) but found ${args.length}`); return; }
    if (this.jumpSkip) { this.jumpSkip = false; return; }
    // A long loop is followed LOOP_LIMIT times, then left as if it had ended.
    const key = `${this.entry.file || ''}|${this.entry.line}`;
    this.loops = this.loops || new Map();
    const n = (this.loops.get(key) || 0) + 1;
    this.loops.set(key, n);
    if (n > LOOP_LIMIT) {
      if (n === LOOP_LIMIT + 1) {
        this.st.uncertain = true;
        this.note('loop-cut', `STEMKit followed this loop ${LOOP_LIMIT} times and carries on after it; what comes later is checked as if the loop had ended.`, { url: page('jump') });
      }
      return;
    }
    const f = this.frames[this.frames.length - 1];
    if (args[0] === 'SELF') {
      f.pc = 0;
    } else {
      const r = this.openFile(args[0], 'jump');
      if (r === 'stop') { f.pc = f.lines.length; return; }
      if (r === null) return;
    }
    if (args.length === 2) this.labelActive = { name: args[1], line: this.entry.line, file: this.entry.file };
  },

  m_label(args) {
    if (args.length !== 1) this.error('bad-args', `Illegal label command: expected 1 argument but found ${args.length}`);
  },

  m_log(args) {
    if (args.length < 1 || args.length > 2) { this.error('bad-args', `Illegal log command: expected 1 or 2 argument(s) but found ${args.length}`); return; }
    if (args.length === 2 && args[1] !== 'append') this.error('bad-value', `Unknown log keyword: ${args[1]}`, `The only keyword of log is append; "${args[1]}" is not it, so LAMMPS stops.`);
  },

  m_next(args) {
    if (!args.length) { this.error('bad-args', 'Illegal next command'); return; }
    const vs = [];
    for (const name of args) {
      const v = this.vars.get(name);
      if (!v) {
        if (this.st.uncertain) return;
        this.error('next-variable', `Invalid variable '${name}' in next command`, `next names variable "${name}", which is not defined (or was used up), so LAMMPS stops.`, { url: page('next') });
        return;
      }
      vs.push(v);
    }
    const style = vs[0].style;
    const mixable = (a, b) => (a === 'universe' && b === 'uloop') || (a === 'uloop' && b === 'universe') || a === b;
    if (vs.some(v => !mixable(style, v.style))) { this.error('next-style', 'All variables in next command must have same style', null, { url: page('next') }); return; }
    if (['string', 'equal', 'world', 'getenv', 'atom', 'vector', 'format', 'python', 'timer', 'internal'].includes(style)) {
      this.error('next-style', 'Invalid variable style with next command', `next only steps index, loop, file, atomfile, universe and uloop variables; "${args[0]}" is ${style}-style, so LAMMPS stops.`, { url: page('next') });
      return;
    }
    let done = false;
    for (const name of args) {
      const v = this.vars.get(name);
      if (v.style === 'file' || v.style === 'atomfile') { done = null; continue; }
      v.which += 1;
      const n = v.style === 'loop' || v.style === 'uloop' ? v.last : v.values.length;
      if (v.which >= n) { done = done === null ? null : true; this.vars.delete(name); }
    }
    if (done === null) {
      // A file variable: whether it is used up depends on the file.
      this.st.uncertain = true;
      this.jumpSkip = true;
      return;
    }
    if (done) this.jumpSkip = true;
  },

  m_partition(args) {
    if (args.length < 3) { this.missing('partition'); return; }
    if (!BOOL_WORDS.has(args[0])) { this.need('bool', args[0]); return; }
    if (args[2] === 'partition') { this.error('bad-args', 'Illegal partition command'); return; }
    const yes = ['yes', 'on', 'true', '1'].includes(args[0]);
    const m = /^(\d*)(\*?)(\d*)$/.exec(args[1]);
    let inRange = null;
    if (m) {
      const lo = m[2] ? (m[1] ? Number(m[1]) : 1) : Number(m[1]);
      const hi = m[2] ? (m[3] ? Number(m[3]) : Infinity) : Number(m[1]);
      inRange = lo <= 1 && 1 <= hi;
    }
    if (inRange === null) return;
    if (yes === inRange) this.exec(this.entry, args.slice(2).join(' '), true);
  },

  m_print(args) {
    if (!args.length) { this.missing('print'); return; }
    if (this.substitute(args[0]) === null) return;
    for (let i = 1; i < args.length;) {
      const k = args[i];
      if (k === 'file' || k === 'append') {
        if (i + 2 > args.length) { this.error('missing-value', `Illegal print ${k} command: missing argument(s)`); return; }
        i += 2;
      } else if (k === 'screen' || k === 'universe') {
        if (i + 2 > args.length) { this.missing(`print ${k}`); return; }
        if (!this.need('bool', args[i + 1], k)) return;
        i += 2;
      } else if (isUnknown(k)) return;
      else {
        this.error('unknown-keyword', `Unknown print keyword: ${k}`, `print takes one text argument and then the keywords file, append, screen and universe; "${k}" is not one. ` +
          'If it is part of the text, put the whole text in quotes.', { url: page('print') });
        return;
      }
    }
  },

  m_python(args) {
    if (this.packages && !this.packages.has('PYTHON')) {
      this.error('missing-package', 'LAMMPS is not built with Python embedded', 'The python command needs a LAMMPS built with the PYTHON package, which this build does not have.', { url: page('python') });
      return;
    }
    this.needPackages(['PYTHON']);
    this.st.uncertain = true;
  },

  m_quit(args) {
    if (args.length > 1) { this.error('bad-args', `Illegal quit command: expected 0 or 1 argument but found ${args.length}`); return; }
    if (args.length === 1 && !this.need('int', args[0], 'quit')) return;
    this.quitLine = this.entry.line;
    throw new Stop();
  },

  m_shell() {
    // Runs programs on the machine: nothing to check here.
  },

  m_variable(args) {
    const url = page('variable');
    this.url = url;
    if (args.length < 2) { this.missing('variable', url); return; }
    const [name, style] = args;
    const n = args.length;
    const exists = this.vars.get(name);
    const line = this.entry.line;
    const expected = (k) => `Illegal variable command: expected ${k} arguments but found ${n + 0}`;
    const redefine = () => {
      this.error('variable-style', 'Cannot redefine variable as a different style',
        `Variable "${name}" was defined as ${exists.style}-style on line ${exists.line}; a variable keeps its style, so LAMMPS stops. Use another name, or "variable ${name} delete" first.`,
        { url, related: [exists.line] });
    };
    const nameOk = () => {
      if (isId(name) || isUnknown(name)) return true;
      this.error('variable-name', `Variable name '${name}' must have only letters, numbers, or underscores`, null, { url });
      return false;
    };
    switch (style) {
      case 'delete':
        if (n !== 2) { this.error('bad-args', `Illegal variable delete command: expected 2 arguments but found ${n}`); return; }
        this.vars.delete(name);
        return;
      case 'index': case 'world': case 'universe':
        if (n < 3) { this.missing(`variable ${style}`, url); return; }
        if (exists) { this.unusedRedefinition(name, exists, style); return; }
        if (style === 'world' && n - 2 !== 1) { this.error('bad-args', "World variable count doesn't match # of partitions", `A world variable needs one value per partition; with a single partition (no -partition), give one value.`, { url }); return; }
        if (!nameOk()) return;
        this.vars.set(name, { style, values: args.slice(2), which: 0, line });
        if (style === 'universe') this.note('universe', 'A universe variable hands its values to the partitions of a multi-partition run (-partition); in a single run it behaves like an index variable.', { url });
        return;
      case 'loop': {
        if (n < 3) { this.missing('variable loop', url); return; }
        if (exists) { this.unusedRedefinition(name, exists, style); return; }
        let first = 1;
        let last;
        let pad = false;
        if (n === 3 || (n === 4 && args[3] === 'pad')) {
          if (!this.need('int', args[2])) return;
          last = Number(args[2]);
          if (!isUnknown(args[2]) && last <= 0) { this.error('bad-value', `Invalid variable loop argument: ${last}`); return; }
          pad = n === 4;
        } else if (n === 4 || (n === 5 && args[4] === 'pad')) {
          if (!this.need('int', args[2]) || !this.need('int', args[3])) return;
          first = Number(args[2]);
          last = Number(args[3]);
          if (first > last || last < 0) { this.error('bad-value', `Illegal variable loop command: ${first} > ${last}`); return; }
          pad = n === 5;
        } else { this.error('bad-args', 'Illegal variable loop command: too many arguments'); return; }
        if (!nameOk()) return;
        this.vars.set(name, { style: 'loop', which: first - 1, last: Number.isFinite(last) ? last : 1, pad: pad ? String(last).length : 0, line });
        return;
      }
      case 'uloop':
        if (n < 3 || n > 4) { this.error('bad-args', `Illegal variable command: expected 3 or 4 arguments but found ${n}`); return; }
        if (n === 4 && args[3] !== 'pad') { this.error('bad-value', `Invalid variable uloop argument: ${args[3]}`); return; }
        if (exists) return;
        if (!this.need('int', args[2])) return;
        if (!nameOk()) return;
        this.vars.set(name, { style: 'uloop', which: 0, last: Number(args[2]) || 1, pad: n === 4 ? String(args[2]).length : 0, line });
        return;
      case 'string': {
        if (n !== 3) { this.error('bad-args', expected(3)); return; }
        const value = this.substitute(args[2]);
        if (value === null) return;
        if (exists && exists.style !== 'string') { redefine(); return; }
        if (!exists && !nameOk()) return;
        this.vars.set(name, { style: 'string', values: [value], which: 0, line });
        return;
      }
      case 'getenv':
        if (n !== 3) { this.error('bad-args', expected(3)); return; }
        if (exists && exists.style !== 'getenv') { redefine(); return; }
        if (!nameOk()) return;
        this.vars.set(name, { style: 'getenv', line });
        return;
      case 'file': case 'atomfile':
        if (n !== 3) { this.error('bad-args', expected(3)); return; }
        if (exists) return;
        if (!nameOk()) return;
        this.vars.set(name, { style, line, file: args[2] });
        this.note('file-variable', `Reads its values from ${args[2]}, which STEMKit does not open.`, { url });
        return;
      case 'format': {
        if (n !== 4) { this.error('bad-args', expected(4)); return; }
        const target = this.vars.get(args[2]);
        if (!target) { if (!this.st.uncertain) this.error('variable-format', `Variable ${name}: format variable ${args[2]} does not exist`, null, { url }); return; }
        if (!['equal', 'internal', 'timer', 'python'].includes(target.style)) { this.error('variable-format', `Variable ${name}: format variable ${args[2]} has incompatible style`, null, { url }); return; }
        if (exists && exists.style !== 'format') { redefine(); return; }
        if (!/^% ?-?[0-9]*\.?[0-9]*[efgEFG]$/.test(args[3]) && !isUnknown(args[3])) { this.error('format', 'Incorrect conversion in format string', null, { url }); return; }
        if (!exists && !nameOk()) return;
        this.vars.set(name, { style: 'format', line, of: args[2], format: args[3] });
        return;
      }
      case 'equal': case 'atom': case 'vector': case 'python':
        if (n !== 3) {
          this.error('bad-args', expected(3), `variable ${name} ${style} takes one formula; this line has ${n - 2} words after "${style}". ` +
            'Put the formula in quotes if it has spaces.', { url });
          return;
        }
        if (style === 'python' && this.packages && !this.packages.has('PYTHON')) { this.error('missing-package', 'LAMMPS is not built with Python embedded', null, { url }); return; }
        if (exists && exists.style !== style) { redefine(); return; }
        if (!exists && !nameOk()) return;
        this.vars.set(name, { style, formula: args[2], line });
        this.checkFormulaSyntax(name, args[2], style);
        return;
      case 'timer':
        if (n !== 2) { this.error('bad-args', expected(2)); return; }
        if (exists && exists.style !== 'timer') { redefine(); return; }
        if (!exists && !nameOk()) return;
        this.vars.set(name, { style: 'timer', line });
        return;
      case 'internal':
        if (n !== 3) { this.error('bad-args', expected(3)); return; }
        if (exists && exists.style !== 'internal') { redefine(); return; }
        if (!this.need('num', args[2])) return;
        if (!exists && !nameOk()) return;
        this.vars.set(name, { style: 'internal', value: isUnknown(args[2]) ? null : Number(args[2]), line });
        return;
      default:
        if (isUnknown(style)) return;
        this.error('variable-style', `Unknown variable keyword: ${style}`,
          `"${style}" is not a variable style, so LAMMPS stops. The styles are index, loop, world, universe, uloop, string, getenv, file, atomfile, format, equal, vector, atom, python, timer and internal.` +
          (didYouMeanIn(style, ['index', 'loop', 'world', 'universe', 'uloop', 'string', 'getenv', 'file', 'atomfile', 'format', 'equal', 'vector', 'atom', 'python', 'timer', 'internal']) ? ` Did you mean ${didYouMeanIn(style, ['index', 'loop', 'world', 'universe', 'uloop', 'string', 'getenv', 'file', 'atomfile', 'format', 'equal', 'vector', 'atom', 'python', 'timer', 'internal'])}?` : ''),
          { url });
    }
  },

  /*
   * index, loop, world, universe, uloop, file and atomfile variables are
   * never redefined: a second definition is skipped without a message, which
   * is how -var on the command line overrides a default in the script.
   */
  unusedRedefinition(name, exists, style) {
    if (exists.line === 0) return;
    if (exists.style !== style || exists.line !== this.entry.line) {
      this.note('variable-kept', `Variable ${name} already exists (line ${exists.line}), so LAMMPS skips this definition without a message: ` +
        `${exists.style}-style variables keep their first value (that is how -var overrides a default).`, { url: page('variable'), related: [exists.line] });
    }
  },

  /* A formula is evaluated only when used; here only its syntax is read. */
  checkFormulaSyntax(name, formula, style) {
    if (isUnknown(formula) || style === 'python') return;
    if (style === 'vector' && formula.startsWith('[')) return;
    try {
      lexFormula(formula);
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      this.warn('formula-syntax', `LAMMPS will not be able to evaluate this formula ("${e.message}") when it is used.${formulaHint(e)}`, { url: page('variable') });
    }
  }
});

/* ---- settings, the box, and the force field ---- */

const UNIT_STYLES = ['lj', 'real', 'metal', 'si', 'cgs', 'electron', 'micro', 'nano'];

Object.assign(Machine.prototype, {
  requireBox(cmd = this.cmd) {
    if (this.st.box) return true;
    const msg = NEEDS_BOX[cmd] || `${cmd[0].toUpperCase()}${cmd.slice(1)} command before simulation box is defined`;
    this.error('needs-box', msg, `${cmd} needs the simulation box, which does not exist yet, so LAMMPS stops ("${msg}"). ` +
      'Create the box first with read_data, read_restart or create_box.');
    return false;
  },

  forbidBox(cmd = this.cmd) {
    if (!this.st.box) return true;
    const msg = BEFORE_BOX[cmd] || `${cmd} command after simulation box is defined`;
    const how = this.st.boxHow ? ` (made by ${this.st.boxHow} on line ${this.st.boxLine})` : '';
    this.error('after-box', msg, `${cmd} must come before the simulation box is created${how}, so LAMMPS stops ("${msg}"). Move it above that line.`,
      { related: [this.st.boxLine] });
    return false;
  },

  c_units(args) {
    if (args.length !== 1) { this.error('bad-args', `Illegal units command: expected 1 argument but found ${args.length}`); return; }
    if (!this.forbidBox()) return;
    const u = args[0];
    if (isUnknown(u)) { this.st.units = null; return; }
    if (!UNIT_STYLES.includes(u)) {
      const near = didYouMeanIn(u, UNIT_STYLES);
      this.error('bad-value', 'Illegal units command', `"${u}" is not a unit style, so LAMMPS stops. The styles are ${UNIT_STYLES.join(', ')}.${near ? ` Did you mean ${near}?` : ''}`);
      return;
    }
    if (this.st.timestep && this.st.timestep.value !== null && this.st.units !== u) {
      this.warn('units-resets-timestep', `units resets the timestep to the default of ${u} units (${UNITS[u].timestep} ${UNITS[u].time}): ` +
        `the timestep set on line ${this.st.timestep.line} is lost. LAMMPS warns ("Changing timestep ... due to changing units"). Put units first.`,
      { related: [this.st.timestep.line] });
      this.st.timestep = null;
    }
    this.st.units = u;
    this.st.unitsLine = this.entry.line;
  },

  c_atom_style(args) {
    if (!args.length) { this.missing('atom_style'); return; }
    if (!this.forbidBox()) return;
    const style = args[0];
    if (!this.checkStyle('atom_style', style, 'atom')) return;
    let props = propsOf(style);
    if (style === 'hybrid') {
      props = {};
      for (const sub of args.slice(1)) {
        if (sub === 'hybrid') { this.error('bad-value', 'Atom style hybrid cannot have hybrid as an argument'); return; }
        // Words that are not atom styles are arguments of the sub-style before them.
        if (!commandInfo('atom_style', sub)) continue;
        if (!this.checkStyle('atom_style', sub, 'atom')) return;
        Object.assign(props, propsOf(sub));
      }
    }
    if (style === 'body' && args[1] !== undefined && !this.checkStyle('body', args[1], 'body')) return;
    if (style === 'template') {
      if (args.length < 2) { this.error('bad-args', 'Illegal atom_style template command'); return; }
      if (!this.st.molecules.has(args[1]) && !this.st.uncertain) {
        this.error('undefined-molecule', `Molecule template ID ${args[1]} for atom style template does not exist`, null, { url: page('atom_style') });
        return;
      }
    }
    this.st.atomStyle = style;
    this.st.atomStyleArgs = args.slice(1);
    this.st.atomStyleLine = this.entry.line;
    this.st.atomProps = props;
  },

  c_dimension(args) {
    if (args.length !== 1) { this.error('bad-args', 'Dimension command expects exactly 1 argument'); return; }
    if (!this.forbidBox()) return;
    if (!this.need('int', args[0])) return;
    if (!isUnknown(args[0]) && args[0] !== '2' && args[0] !== '3' && Number(args[0]) !== 2 && Number(args[0]) !== 3) { this.error('bad-value', `Invalid dimension argument: ${args[0]}`); return; }
    this.st.dimension = isUnknown(args[0]) ? null : Number(args[0]);
    this.st.dimensionLine = this.entry.line;
  },

  c_boundary(args) {
    if (!this.forbidBox()) return;
    if (args.length !== 3) { this.error('bad-args', 'Illegal boundary command', `boundary takes three values, one per direction (e.g. p p p), so LAMMPS stops.`); return; }
    for (const a of args) {
      if (isUnknown(a)) continue;
      if (!/^[pfsm]{1,2}$/.test(a) || (a.length === 2 && (a.includes('p')))) {
        this.error('bad-value', 'Unknown boundary keyword: ' + a, `"${a}" is not a boundary style: use p (periodic), f (fixed), s (shrink-wrapped) or m (shrink-wrapped with a minimum), one letter per direction or two for the lower and upper faces.`);
        return;
      }
    }
    this.st.boundary = args.slice();
  },

  c_newton(args) {
    if (args.length < 1 || args.length > 2) { this.error('bad-args', 'Illegal newton command'); return; }
    for (const a of args) if (!this.need('bool', a)) return;
    const pair = ['yes', 'on', 'true', '1'].includes(args[0]);
    const bond = ['yes', 'on', 'true', '1'].includes(args[args.length - 1]);
    if (this.st.box && this.st.newtonBond !== undefined && bond !== this.st.newtonBond) { this.error('after-box', 'Newton bond change after simulation box is defined'); return; }
    this.st.newtonPair = pair;
    if (!this.st.box) this.st.newtonBond = bond;
  },

  c_package(args) {
    if (!this.forbidBox()) return;
    if (!args.length) { this.error('bad-args', 'Illegal package command'); return; }
    const pk = { gpu: 'GPU', kokkos: 'KOKKOS', omp: 'OPENMP', intel: 'INTEL' }[args[0]];
    if (!pk) { if (!isUnknown(args[0])) this.error('bad-value', `Unknown package keyword: ${args[0]}`); return; }
    if (this.packages && !this.packages.has(pk)) {
      const msg = { GPU: 'Package gpu command without GPU package installed', KOKKOS: 'Package kokkos command without KOKKOS package enabled',
        OPENMP: 'Package omp command without OPENMP package installed', INTEL: 'Package intel command without INTEL package installed' }[pk];
      this.error('missing-package', msg, `package ${args[0]} needs the ${pk} package, which this build does not have, so LAMMPS stops.`);
      return;
    }
    this.needPackages([pk]);
  },

  c_suffix(args) {
    if (!args.length) { this.error('bad-args', 'Illegal suffix command'); return; }
    if (['off', 'no', 'false'].includes(args[0])) { this.st.suffixOn = false; return; }
    if (['on', 'yes', 'true'].includes(args[0])) {
      if (!this.st.suffix) this.error('bad-args', 'May only enable suffixes after defining one');
      this.st.suffixOn = true;
      return;
    }
    if (args[0] === 'hybrid' ? args.length !== 3 : args.length !== 1) { this.error('bad-args', 'Illegal suffix command'); return; }
    this.st.suffix = args[0] === 'hybrid' ? args.slice(1) : [args[0]];
    this.st.suffixOn = true;
  },

  c_timestep(args) {
    if (args.length !== 1) { this.error('bad-args', 'Illegal timestep command', 'timestep takes one value, so LAMMPS stops ("Illegal timestep command").'); return; }
    let value = args[0];
    if (value.startsWith('v_')) value = UNKNOWN;
    if (!this.need('num', value, 'timestep')) return;
    this.st.timestep = { value: isUnknown(value) ? null : Number(value), line: this.entry.line };
    if (!isUnknown(value) && Number(value) <= 0) this.note('timestep-nonpositive', `A timestep of ${value} does not move the atoms: runs only evaluate the system as it is (fine for static calculations).`);
  },

  c_thermo(args) {
    if (args.length !== 1) { this.error('bad-args', 'Illegal thermo command', 'thermo takes one value (every how many steps), so LAMMPS stops.'); return; }
    if (args[0].startsWith('v_')) {
      this.st.thermo = { every: null, variable: args[0].slice(2), line: this.entry.line };
      return;
    }
    if (!this.need('int', args[0], 'thermo')) return;
    const n = isUnknown(args[0]) ? null : Number(args[0]);
    if (n !== null && n < 0) { this.error('bad-value', `Illegal thermo output frequency ${n}`); return; }
    this.st.thermo = { every: n, line: this.entry.line };
  },

  /* ---- force field ---- */

  c_pair_style(args) {
    if (!args.length) { this.missing('pair_style'); return; }
    const style = args[0];
    const st = this.st;
    if (st.pair && st.pair.style === style) {
      st.pair.args = args.slice(1);
      st.pair.line = this.entry.line;
      this.checkSpec(`pair_style ${baseStyle(style)}`, args.slice(1));
      return;
    }
    st.pairRestart = null;
    if (style !== 'none' && !this.checkStyle('pair_style', style, 'pair')) { st.pair = { style, args: args.slice(1), line: this.entry.line, broken: true, subs: [] }; return; }
    st.pair = style === 'none' ? null : { style, args: args.slice(1), line: this.entry.line, subs: [], coeffs: [] };
    st.pairCoeffs = [];
    if (!st.pair) return;
    if (/^hybrid/.test(style)) this.hybridSubstyles(args.slice(1));
    else this.pairSettings(style, args.slice(1));
  },

  /* The settings of a pair style: how many words, and of what type. */
  pairSettings(style, words) {
    const base = baseStyle(style);
    const info = PAIR_INFO[base];
    if (base === 'tracker' && words.length < 2 && !words.some(isUnknown)) {
      this.error('pair-style-args', 'Illegal pair_style command', 'pair_style tracker needs at least a fix ID and how often to store, so LAMMPS stops.', { url: lammpsDocUrl('pair_style', base) });
      return;
    }
    if (!info || !info.s) { this.checkSpec(`pair_style ${base}`, words); return; }
    if (words.some(isUnknown)) return;
    if (!info.s.includes(words.length)) {
      const lammps = info.sm || 'Illegal pair_style command';
      const n = info.s.length === 1 ? `${info.s[0]}` : `${info.s.slice(0, -1).join(', ')} or ${info.s[info.s.length - 1]}`;
      const names = (commandInfo('pair_style', base) || {}).args;
      this.error('pair-style-args', lammps, `pair_style ${base} takes ${n} setting${n === '1' ? '' : 's'}${names && names.length ? ` (${names.join(' ')})` : ''}; ` +
        `this line has ${words.length}, so LAMMPS stops ("${lammps}").`, { url: lammpsDocUrl('pair_style', base) });
      return;
    }
    const types = info.st ? info.st.split(' ') : [];
    for (let i = 0; i < words.length && i < types.length; i++) {
      const t = types[i] === 'n' ? 'num' : types[i] === 'i' ? 'int' : types[i].includes('|') ? `choice:${types[i]}` : '';
      if (!t) continue;
      const prob = typeProblem(t, words[i]);
      if (prob === 'choice') { this.error('bad-value', 'Illegal pair_style command', `"${words[i]}" is not one of ${types[i].split('|').join(', ')} for pair_style ${base}, so LAMMPS stops.`); return; }
      if (prob) { this.error('bad-value', prob, `pair_style ${base}: "${words[i]}" is not ${typeWords[t]}, so LAMMPS stops.`); return; }
    }
    if (/^(lj|buck)\/long\/(coul|tip4p)\/long$/.test(base)) this.st.pair.longFlags = words;
  },

  /* pair_style hybrid: every word that names a pair style starts a sub-style. */
  hybridSubstyles(words) {
    const subs = [];
    let i = 0;
    const scaled = this.st.pair.style.startsWith('hybrid/scaled');
    while (i < words.length) {
      if (scaled) {
        // hybrid/scaled: factor sub-style args ...
        if (isLammpsNumber(words[i]) || words[i].startsWith('v_')) i += 1;
      }
      const w = words[i];
      if (w === undefined) break;
      if (/^hybrid/.test(w)) { this.error('bad-value', 'Pair style hybrid cannot have hybrid as a sub-style'); return; }
      if (!isUnknown(w) && w !== 'none' && !this.checkStyle('pair_style', w, 'pair')) return;
      const sub = { style: w, args: [] };
      i += 1;
      while (i < words.length && !(styleExists('pair_style', words[i]) && !isLammpsNumber(words[i])) && !(scaled && (isLammpsNumber(words[i]) || words[i].startsWith('v_')) && i + 1 < words.length && styleExists('pair_style', words[i + 1]))) {
        sub.args.push(words[i]);
        i += 1;
      }
      subs.push(sub);
    }
    this.st.pair.subs = subs;
    for (const sub of subs) if (sub.style !== 'none') this.pairSettings(sub.style, sub.args);
  },

  c_pair_coeff(args) {
    const st = this.st;
    if (!this.requireBox('pair_coeff')) return;
    if (!st.pair) {
      if (st.fromRestart || st.uncertain) return;
      this.error('no-pair-style', 'Pair_coeff command without a pair style', 'pair_coeff comes before any pair_style, so LAMMPS stops. Put the pair_style line first.');
      return;
    }
    if (args.length < 2) { this.missing('pair_coeff'); return; }
    if (st.pair.broken) return;
    let style = st.pair.style;
    let rest = args.slice(2);
    if (/^hybrid/.test(style)) {
      const sub = rest[0];
      if (sub === undefined) { this.error('bad-args', 'Incorrect args for pair coefficients'); return; }
      const matches = (st.pair.subs || []).filter(s => s.style === sub);
      if (!matches.length && sub !== 'none' && !isUnknown(sub)) {
        this.error('bad-args', 'Pair coeff for hybrid has invalid style: ' + sub,
          `With pair_style ${style}, the third word of pair_coeff names one of its sub-styles (${(st.pair.subs || []).map(s => s.style).join(', ')}); "${sub}" is not one, so LAMMPS stops.`);
        return;
      }
      rest = rest.slice(1);
      if (matches.length > 1) rest = rest.slice(1);
      style = sub;
    }
    st.pairCoeffs.push({ i: args[0], j: args[1], style, line: this.entry.line });
    this.checkTypeRange(args[0], 'atom') && this.checkTypeRange(args[1], 'atom');
    this.checkPairCoeff(style, args.slice(0, 2), rest);
    this.massesFromPotential(baseStyle(style), args[0], args[1], rest);
  },

  /*
   * EAM, ADP, EIM, MEAM and BOP set the masses of the types they map from
   * the potential file (Pair*::coeff calls atom->set_mass).
   */
  massesFromPotential(style, wi, wj, rest) {
    if (!MASS_FROM_FILE.test(style)) return;
    const st = this.st;
    if (style === 'eam') {
      const is = this.typeList(wi);
      const js = this.typeList(wj);
      if (!is || !js) { st.masses.add('*'); return; }
      for (const t of is) if (js.includes(t)) st.masses.add(t);
      return;
    }
    const n = st.ntypes;
    if (!n || rest.length < n) { st.masses.add('*'); return; }
    const elements = rest.slice(rest.length - n);
    elements.forEach((el, k) => { if (el !== 'NULL') st.masses.add(k + 1); });
  },

  /* utils::bounds for type ranges like 1*3, when the number of types is known. */
  checkTypeRange(word, kind) {
    if (isUnknown(word)) return true;
    const n = kind === 'atom' ? this.st.ntypes : null;
    if (!/^[*\-0-9]*$/.test(word)) return true; // a type label
    if (word === '*') return true;
    const m = /^(\d*)(\*?)(\d*)$/.exec(word);
    if (!m) { this.error('bad-value', `Invalid range string: ${word}`); return false; }
    const lo = m[1] ? Number(m[1]) : 1;
    const hi = m[2] ? (m[3] ? Number(m[3]) : n) : lo;
    if (lo <= 0 || (hi !== null && hi <= 0)) { this.error('bad-value', `Invalid range string: ${word}`); return false; }
    if (n !== null && n !== undefined && hi !== null && hi > n) {
      this.error('bad-type', `Numeric index ${hi} is out of bounds (1-${n})`, `Atom type ${hi} does not exist: the box has ${PLURAL(n, 'atom type')} (create_box on line ${this.st.boxLine}), so LAMMPS stops.`, { related: [this.st.boxLine] });
      return false;
    }
    return true;
  },

  checkPairCoeff(style, ij, rest) {
    const base = baseStyle(style);
    const info = PAIR_INFO[base];
    if (!info) return;
    const inHybrid = /^hybrid/.test(this.st.pair.style);
    if (info.one && !inHybrid && (ij[0] !== '*' || ij[1] !== '*') && !isUnknown(ij[0]) && !isUnknown(ij[1])) {
      this.error('pair-coeff-star', `Pair_coeff must start with * * for pair style ${style}`,
        `pair_style ${style} sets all types at once from its potential file, so its pair_coeff line must start with "* *"; LAMMPS stops.`);
      return;
    }
    if (rest.some(isUnknown)) return;
    const n = rest.length;
    const msg = info.cm || 'Incorrect args for pair coefficients';
    if (info.c === 'ntypes') {
      const nt = this.st.ntypes;
      if (nt && n !== nt + 1) {
        this.error('pair-coeff-count', msg, `pair_coeff for ${style} takes the potential file and then one element name (or NULL) per atom type: ` +
          `${nt + 1} words after "* *" for ${PLURAL(nt, 'type')}; this line has ${n}, so LAMMPS stops ("${msg}").`);
      }
      return;
    }
    if (Array.isArray(info.c) && !info.c.includes(n)) {
      const allowed = info.c.length === 1 ? `${info.c[0]}` : `${info.c.slice(0, -1).join(', ')} or ${info.c[info.c.length - 1]}`;
      this.error('pair-coeff-count', msg,
        `pair_coeff for ${style} takes ${allowed} value${allowed === '1' ? '' : 's'} after the two atom types; this line has ${n}, so LAMMPS stops ("${msg}").`,
        { url: lammpsDocUrl('pair_style', base) });
      return;
    }
    const types = info.ct ? info.ct.split(' ') : [];
    for (let k = 0; k < n && k < types.length; k++) {
      const t = types[k] === 'n' ? 'num' : types[k] === 'i' ? 'int' : '';
      if (!t) continue;
      const p = typeProblem(t, rest[k]);
      if (p) { this.error('bad-value', p, `pair_coeff for ${style}: "${rest[k]}" is not ${typeWords[t]}, so LAMMPS stops.`); return; }
    }
  },

  c_pair_modify(args) {
    if (!this.st.pair) {
      if (this.st.fromRestart || this.st.uncertain) return;
      this.error('no-pair-style', 'Pair_modify command before pair_style is defined', 'pair_modify comes before pair_style, so LAMMPS stops. Put the pair_style line first.');
      return;
    }
    this.checkSpec('pair_modify', args);
    const i = args.indexOf('mix');
    if (i >= 0 && args[i + 1]) this.st.pair.mix = args[i + 1];
    const t = args.indexOf('tail');
    if (t >= 0) this.st.pair.tail = args[t + 1];
    const sh = args.indexOf('shift');
    if (sh >= 0) this.st.pair.shift = args[sh + 1];
  },

  bondedStyle(kind, args) {
    const cmd = `${kind}_style`;
    if (!args.length) { this.error('bad-args', `Illegal ${cmd} command`); return; }
    const allow = { bond: 'bonds', angle: 'angles', dihedral: 'dihedrals', improper: 'impropers' }[kind];
    if (!this.st.atomProps[allow] && !this.st.fromRestart && this.st.atomStyle) {
      const lammps = `${cmd[0].toUpperCase()}${cmd.slice(1)} command when no ${allow} allowed`;
      this.error('no-topology', lammps, `atom_style ${this.st.atomStyle} has no ${allow}, so LAMMPS stops ("${lammps}"). ` +
        'Use atom_style bond, angle, molecular or full (or hybrid with one of them) for a molecular system.', { related: [this.st.atomStyleLine] });
      return;
    }
    const style = args[0];
    if (style !== 'none' && !this.checkStyle(cmd, style, kind)) return;
    this.st.bonded[kind] = style === 'none' ? { style: 'none', line: this.entry.line } : { style, args: args.slice(1), line: this.entry.line };
    // The tables count the style name as the first word (prefix 1).
    if (style !== 'none' && style !== 'hybrid') this.checkSpec(`${cmd} ${baseStyle(style)}`, args);
  },

  bondedCoeff(kind, args) {
    const cmd = `${kind}_coeff`;
    const Cmd = `${cmd[0].toUpperCase()}${cmd.slice(1)}`;
    if (!this.requireBox(cmd)) return;
    const s = this.st.bonded[kind];
    if (!s) {
      if (this.st.fromRestart || this.st.uncertain) return;
      this.error('no-style', `${Cmd} command before ${kind}_style is defined`, `${cmd} comes before any ${kind}_style, so LAMMPS stops. Put the ${kind}_style line first.`);
      return;
    }
    const allow = { bond: 'bonds', angle: 'angles', dihedral: 'dihedrals', improper: 'impropers' }[kind];
    if (!this.st.atomProps[allow] && !this.st.fromRestart) { this.error('no-topology', `${Cmd} command when no ${allow} allowed`); return; }
    if (s.style === 'none') return;
    (this.st.bondedCoeffLines || (this.st.bondedCoeffLines = {}))[kind] = true;
    let style = s.style;
    let rest = args.slice(1);
    if (style === 'hybrid') { style = rest[0]; rest = rest.slice(1); }
    if (!style || rest.some(isUnknown)) return;
    // class2 and friends take sub-forms (bb, ba, mbt, ...) with their own counts.
    if (/^(bb|ba|mbt|ebt|at|aat|bb13|aa)$/.test(rest[0] || '')) return;
    if (kind === 'dihedral' && /^charmm(fsw)?$/.test(baseStyle(style)) && isLammpsNumber(rest[3] || '') && Number(rest[3]) > 0) this.st.charmmWeight = true;
    const spec = specFor(`${cmd} ${baseStyle(style)}`);
    if (!spec) return;
    const want = spec.pos.filter(p => p.type !== 'rest').length;
    if (spec.pos.some(p => p.type === 'rest')) return;
    if (rest.length !== want) {
      const lammps = spec.minMsg || `Incorrect args for ${kind} coefficients`;
      const names = spec.pos.map(p => p.name).filter(Boolean);
      this.error('coeff-count', lammps, `${cmd} for ${kind}_style ${style} takes ${PLURAL(want, 'value')} after the type${names.length ? ` (${names.join(', ')})` : ''}; ` +
        `this line has ${rest.length}, so LAMMPS stops ("${lammps}").`, { url: lammpsDocUrl(`${kind}_style`, style) });
      return;
    }
    spec.pos.forEach((p, k) => {
      if (this.coeffBad) return;
      const prob = typeProblem(p.type, rest[k]);
      if (prob && prob !== 'choice') { this.error('bad-value', prob, `${cmd}: ${p.name || 'value'} "${rest[k]}" is not ${typeWords[p.type] || p.type}, so LAMMPS stops.`); this.coeffBad = true; }
    });
    this.coeffBad = false;
  },

  c_bond_style(a) { this.bondedStyle('bond', a); },
  c_angle_style(a) { this.bondedStyle('angle', a); },
  c_dihedral_style(a) { this.bondedStyle('dihedral', a); },
  c_improper_style(a) { this.bondedStyle('improper', a); },
  c_bond_coeff(a) { this.bondedCoeff('bond', a); },
  c_angle_coeff(a) { this.bondedCoeff('angle', a); },
  c_dihedral_coeff(a) { this.bondedCoeff('dihedral', a); },
  c_improper_coeff(a) { this.bondedCoeff('improper', a); },

  c_kspace_style(args) {
    if (!args.length) { this.missing('kspace_style'); return; }
    const style = args[0];
    if (style === 'none') { this.st.kspace = null; return; }
    if (!this.checkStyle('kspace_style', style, 'kspace')) return;
    this.st.kspace = { style, args: args.slice(1), line: this.entry.line };
    this.checkSpec(`kspace_style ${baseStyle(style)}`, args);
  },

  c_kspace_modify(args) {
    if (!this.st.kspace) {
      if (this.st.fromRestart || this.st.uncertain) return;
      this.error('no-kspace', 'KSpace style has not yet been set', 'kspace_modify comes before kspace_style, so LAMMPS stops. Put the kspace_style line first.');
      return;
    }
    // Other packages' kspace styles (scafacos ...) take keywords of their own.
    const r = /^(pppm|ewald|msm)/.test(baseStyle(this.st.kspace.style)) ? this.checkSpec('kspace_modify', args) : { kw: new Map() };
    if (r === null) return;
    const slab = args.indexOf('slab');
    if (slab >= 0) this.st.kspace.slab = args[slab + 1];
    if (args.includes('gewald')) this.st.kspace.gewald = true;
  },

  c_special_bonds(args) {
    const r = this.checkSpec('special_bonds', args);
    if (!r) return;
    const sb = this.st.special;
    for (const [k, v] of r.kw) {
      const nums = v.map(Number);
      if (k === 'lj/coul') { sb.lj = nums; sb.coul = nums.slice(); }
      else if (k === 'lj') sb.lj = nums;
      else if (k === 'coul') sb.coul = nums;
    }
    for (const w of args) {
      if (w === 'amber') { sb.lj = [0, 0, 0.5]; sb.coul = [0, 0, 5 / 6]; }
      else if (w === 'charmm') { sb.lj = [0, 0, 0]; sb.coul = [0, 0, 0]; }
      else if (w === 'dreiding') { sb.lj = [0, 0, 1]; sb.coul = [0, 0, 1]; }
      else if (w === 'fene') { sb.lj = [0, 1, 1]; sb.coul = [0, 1, 1]; }
    }
    sb.line = this.entry.line;
  },

  c_mass(args) {
    if (args.length !== 2) { this.error('bad-args', `Illegal mass command: expected 2 arguments but found ${args.length}`, `mass takes a type (or range) and a mass, so LAMMPS stops.`); return; }
    if (!this.requireBox('mass')) return;
    if (PER_ATOM_MASS_STYLES.has(this.st.atomStyle)) {
      this.error('mass-style', `Cannot set per-type atom mass for atom style ${this.st.atomStyle}`, `atom_style ${this.st.atomStyle} gives each particle its own mass (from its size and density), so LAMMPS stops at mass. Remove the mass lines.`);
      return;
    }
    if (!this.checkTypeRange(args[0], 'atom')) return;
    if (!this.need('num', args[1], 'mass')) return;
    if (!isUnknown(args[1]) && Number(args[1]) <= 0) { this.error('bad-value', `Invalid atom mass value ${Number(args[1])} for type ${args[0]}`, `A mass must be positive; ${args[1]} is not, so LAMMPS stops.`); return; }
    this.markTypes(this.st.masses, args[0]);
  },

  markTypes(set, word) {
    if (isUnknown(word)) { set.add('*'); return; }
    const n = this.st.ntypes;
    const m = /^(\d*)(\*?)(\d*)$/.exec(word);
    if (!m) { set.add('*'); return; }
    const lo = m[1] ? Number(m[1]) : 1;
    const hi = m[2] ? (m[3] ? Number(m[3]) : (n || lo)) : lo;
    if (m[2] && !m[3] && !n) { set.add('*'); return; }
    for (let t = lo; t <= hi; t++) set.add(t);
  }
});

/* Pair styles that set the masses of the types they map (see massesFromPotential). */
const MASS_FROM_FILE = /^(eam|eam\/alloy|eam\/fs|eam\/he|eam\/cd|eam\/cd\/old|adp|eim|meam|meam\/c|meam\/ms|bop|mgpt|rann)$/;

/* A style without its accelerator suffix: lj/cut/omp -> lj/cut. */
function baseStyle(style) {
  return String(style).replace(/\/(gpu|intel|kk|omp|opt)(\/device|\/host)?$/, '');
}

/* ---- the box, atoms, groups and regions ---- */

Object.assign(Machine.prototype, {
  makeBox(how) {
    const st = this.st;
    st.box = true;
    st.boxHow = how;
    st.boxLine = this.entry.line;
    st.boxFile = this.entry.file;
    if (st.dimension === 2 && st.boundary[2] !== 'p' && how !== 'read_restart') {
      this.error('2d-boundary', 'Cannot run 2d simulation with nonperiodic Z dimension', 'A 2d simulation needs a periodic z boundary (boundary ... ... p), so LAMMPS stops.');
    }
  },

  c_read_data(args) {
    const st = this.st;
    if (!args.length) { this.missing('read_data'); return; }
    const add = args.indexOf('add');
    if (st.dimension === 2 && st.boundary[2] !== 'p') { this.error('2d-boundary', 'Cannot run 2d simulation with nonperiodic Z dimension'); return; }
    if (st.box && add < 0) {
      this.error('box-exists', 'Cannot use read_data without add keyword after simulation box is defined',
        `The box already exists (${st.boxHow} on line ${st.boxLine}), so a second read_data needs the add keyword (add append, add merge, or add with an ID offset); LAMMPS stops.`,
        { related: [st.boxLine] });
      return;
    }
    if (!st.box && add >= 0) { this.error('needs-box', 'Cannot use read_data add before simulation box is defined'); return; }
    const r = this.checkSpec('read_data', args);
    if (r === null) return;
    const file = args[0];
    if (!st.box) {
      this.makeBox('read_data');
      st.ntypes = null;
      st.dataFile = file;
      const info = this.dataInfo(file);
      if (info) {
        if (info.types && info.types.atom) st.ntypes = info.types.atom;
        if (info.massesSet) for (let t = 1; t <= st.ntypes; t++) st.masses.add(t);
        if (info.pairCoeffs) st.pairCoeffsFromData = true;
      } else {
        st.masses.add('*');
        st.pairCoeffsFromData = null; // unknown
      }
    }
    if (r.kw && r.kw.has('extra/atom/types')) st.ntypes = null;
    st.charges = null; // a data file can hold charges
    if (r.kw && r.kw.has('group')) {
      const g = r.kw.get('group')[0];
      if (!st.groups.has(g)) st.groups.set(g, { line: this.entry.line });
    }
  },

  /* What the caller knows about a data file: options.data[name]. */
  dataInfo(name) {
    const d = this.options && this.options.data;
    return d && Object.prototype.hasOwnProperty.call(d, name) ? d[name] : null;
  },

  c_read_restart(args) {
    if (args.length !== 1 && args.length !== 2) { this.error('bad-args', 'Illegal read_restart command'); return; }
    if (this.st.box) { this.error('box-exists', 'Cannot read_restart after simulation box is defined', `The box already exists (${this.st.boxHow} on line ${this.st.boxLine}); read_restart must come first (after units and the like), so LAMMPS stops.`, { related: [this.st.boxLine] }); return; }
    const st = this.st;
    const known = this.restartState(args[0]);
    this.makeBox('read_restart');
    st.restartTimestep = true;
    if (known) {
      this.restoreState(known);
      this.note('restart-known', `Reads ${args[0]}, written by ${known.from}: the units (${known.units}), atom style, box, groups, masses, force field and special_bonds come from there.`,
        { url: page('read_restart') });
      return;
    }
    // A restart file brings back the units, atom style, box, groups, force
    // field (for most pair styles), special_bonds and timestep: from here on
    // the script alone does not say what they are.
    st.fromRestart = true;
    st.charges = null;
    st.units = null;
    st.ntypes = null;
    st.masses.add('*');
    st.atomStyle = null;
    st.atomProps = { q: true, mol: true, bonds: true, angles: true, dihedrals: true, impropers: true, radius: true };
    if (!st.pair) st.pairFromRestart = true;
  },

  /* What a restart file holds (read_restart.html): units, atom style, box, groups, masses, force field, special_bonds, timestep. */
  snapshot(from) {
    const st = this.st;
    const pair = st.pair && !st.pair.broken ? { ...st.pair, subs: (st.pair.subs || []).slice() } : null;
    return {
      from, units: st.units, atomStyle: st.atomStyle, atomProps: { ...st.atomProps }, atomStyleLine: null, dimension: st.dimension,
      boundary: st.boundary.slice(), ntypes: st.ntypes, masses: new Set(st.masses), pair, pairCoeffs: st.pairCoeffs.slice(),
      bonded: { ...st.bonded }, special: { ...st.special }, groups: new Map([...st.groups].map(([k, v]) => [k, { ...v, line: 0 }])),
      timestep: st.timestep ? { value: st.timestep.value, line: 0 } : null, newtonBond: st.newtonBond, fromRestart: st.fromRestart, uncertain: st.uncertain
    };
  },

  restoreState(snap) {
    const st = this.st;
    Object.assign(st, {
      units: snap.units, atomStyle: snap.atomStyle, atomProps: { ...snap.atomProps }, dimension: snap.dimension, boundary: snap.boundary.slice(),
      ntypes: snap.ntypes, masses: new Set(snap.masses), bonded: { ...snap.bonded }, special: { ...snap.special },
      groups: new Map([...snap.groups].map(([k, v]) => [k, { ...v }])), newtonBond: snap.newtonBond,
      fromRestart: snap.fromRestart, uncertain: st.uncertain || snap.uncertain
    });
    if (snap.timestep) st.timestep = { ...snap.timestep };
    // Pair styles that read their parameters from files do not store them.
    const pair = snap.pair;
    if (pair && (PAIR_INFO[baseStyle(pair.style)] || {}).mb) st.pairRestart = pair.style;
    else if (pair && /^hybrid/.test(pair.style)) st.pairFromRestart = true;
    else if (pair) { st.pair = { ...pair, line: 0 }; st.pairCoeffs = snap.pairCoeffs.slice(); }
  },

  /* The state a restart file was written with, when this run of checks knows it. */
  restartState(name) {
    const saved = this.options && this.options.restartStates;
    if (saved) {
      for (const [pattern, snap] of saved) if (restartNameMatch(pattern, name)) return snap;
    }
    const given = this.options && this.options.restart;
    if (given) {
      const snap = this.snapshot('options.restart');
      Object.assign(snap, given.units ? { units: given.units } : {}, given.atomStyle ? { atomStyle: given.atomStyle, atomProps: propsOf(given.atomStyle) } : {});
      if (given.types) snap.ntypes = given.types;
      if (given.types) snap.masses = new Set(Array.from({ length: given.types }, (_, i) => i + 1));
      else snap.masses = new Set(['*']);
      if (given.pairStyle) snap.pair = { style: given.pairStyle, args: [], line: 0, subs: [] };
      if (given.timestep) snap.timestep = { value: given.timestep, line: 0 };
      snap.fromRestart = !given.types;
      return snap;
    }
    return null;
  },

  /* Remember what write_restart and restart save, for checkChain. */
  saveRestart(name, from) {
    if (!name || isUnknown(name)) return;
    (this.savedRestarts || (this.savedRestarts = new Map())).set(name, this.snapshot(from));
  },

  c_create_box(args) {
    const st = this.st;
    if (st.box) { this.error('box-exists', 'Cannot create_box after simulation box is defined', `The box already exists (${st.boxHow} on line ${st.boxLine}), so LAMMPS stops.`, { related: [st.boxLine] }); return; }
    if (st.dimension === 2 && st.boundary[2] !== 'p') { this.error('2d-boundary', 'Cannot run 2d simulation with nonperiodic Z dimension'); return; }
    if (args.length < 2) { this.missing('create_box'); return; }
    if (!this.need('int', args[0], 'number of atom types')) return;
    if (args[1] !== 'NULL' && !st.regions.has(args[1]) && !isUnknown(args[1])) {
      if (!st.uncertain) { this.error('undefined-region', `Create_box region ${args[1]} does not exist`, `create_box uses region "${args[1]}", which is not defined, so LAMMPS stops. Define it with region first.`, { url: page('create_box') }); return; }
    }
    // create_box N NULL alo ahi blo bhi clo chi: a general triclinic box from the lattice vectors.
    const r = args[1] === 'NULL' ? { kw: new Map() } : this.checkSpec('create_box', args);
    if (r === null) return;
    for (const k of ['bond/types', 'angle/types', 'dihedral/types', 'improper/types', 'extra/bond/per/atom', 'extra/angle/per/atom', 'extra/dihedral/per/atom', 'extra/improper/per/atom']) {
      if (r.kw.has(k)) {
        const what = k.startsWith('extra') ? k.split('/')[1] + 's' : k.split('/')[0] + 's';
        if (!st.atomProps[what]) {
          this.error('no-topology', `No ${what} allowed with atom style ${st.atomStyle}`, `create_box ${k} needs an atom style with ${what} (atom_style ${st.atomStyle} has none), so LAMMPS stops.`, { related: [st.atomStyleLine] });
          return;
        }
      }
    }
    this.makeBox('create_box');
    st.ntypes = isUnknown(args[0]) ? null : Number(args[0]);
    st.natoms = 0;
    st.charges = false; // atoms made by create_atoms start without charge
  },

  c_create_atoms(args) {
    if (!this.requireBox('create_atoms')) return;
    if (args.length < 2) { this.missing('create_atoms'); return; }
    if (!this.need('int', args[0], 'atom type')) return;
    const style = args[1];
    if (style === 'region' && args[2] && !this.st.regions.has(args[2]) && !this.st.uncertain && !isUnknown(args[2])) {
      this.error('undefined-region', `Create_atoms region ID ${args[2]} does not exist`, `create_atoms uses region "${args[2]}", which is not defined, so LAMMPS stops.`);
      return;
    }
    if ((style === 'box' || style === 'region') && !this.st.lattice && !this.st.uncertain) {
      this.error('no-lattice', 'Cannot create atoms with undefined lattice', 'create_atoms box or region places atoms on the lattice, but no lattice command came before it, so LAMMPS stops. Add a lattice command.', { url: page('lattice') });
      return;
    }
    if (!isUnknown(args[0]) && args[0] !== '0' && this.st.ntypes && Number(args[0]) > this.st.ntypes) {
      this.error('bad-type', 'Invalid atom type in create_atoms command', `Atom type ${args[0]} does not exist (the box has ${PLURAL(this.st.ntypes, 'type')}), so LAMMPS stops.`);
      return;
    }
    this.checkSpec(SPECS[`create_atoms ${style}`] ? `create_atoms ${style}` : 'create_atoms', args);
    this.st.natoms = null;
    // Molecule templates can carry charges.
    if (args.includes('mol')) this.st.charges = null;
  },

  c_lattice(args) {
    if (!args.length) { this.missing('lattice'); return; }
    if (args[0] === 'none') {
      this.st.lattice = args.length >= 2 ? { style: 'none', line: this.entry.line } : null;
      if (args.length < 2) { this.missing('lattice'); }
      return;
    }
    const ok = this.checkSpec('lattice', args);
    if (ok === null) return;
    if (args.length < 2) { this.missing('lattice'); return; }
    if (!this.need('num', args[1], 'lattice scale')) return;
    if (this.st.units === 'lj' && args[0] !== 'none' && !isUnknown(args[1])) {
      this.st.lattice = { style: args[0], scale: Number(args[1]), reduced: true, line: this.entry.line };
    } else this.st.lattice = { style: args[0], scale: Number(args[1]), line: this.entry.line };
  },

  c_region(args) {
    const st = this.st;
    if (args.length < 2) { this.missing('region'); return; }
    const [id, style] = args;
    if (style === 'delete') { st.regions.delete(id); return; }
    if (style === 'none') { this.error('unknown-style', "Unrecognized region style 'none'"); return; }
    if (st.regions.has(id)) {
      this.error('region-reuse', `Reuse of region ID ${id}`, `Region "${id}" already exists (line ${st.regions.get(id).line}); region IDs cannot be redefined, so LAMMPS stops. Use another ID, or "region ${id} delete" first.`, { related: [st.regions.get(id).line] });
      return;
    }
    if (!this.checkStyle('region', style, 'region')) return;
    if (!st.box && args.slice(2).some(w => /^(INF|EDGE|-INF)$/.test(w))) {
      this.error('needs-box', 'Cannot use region INF or EDGE when box does not exist', 'INF and EDGE stand for the box bounds, but the box does not exist yet, so LAMMPS stops. Give numbers, or create the box first.');
      return;
    }
    if (style === 'union' || style === 'intersect') {
      const n = Number(args[2]);
      if (!this.need('int', args[2], 'number of regions')) return;
      for (const sub of args.slice(3, 3 + n)) {
        if (!st.regions.has(sub) && !st.uncertain && !isUnknown(sub)) {
          this.error('undefined-region', `Region union region ID ${sub} not found`, `Region "${sub}" is not defined, so LAMMPS stops.`);
          return;
        }
      }
    }
    const r = this.checkSpec(`region ${style}`, args);
    if (r === null) return;
    st.regions.set(id, { style, line: this.entry.line });
  },

  c_group(args) {
    const st = this.st;
    if (!this.requireBox('group')) return;
    if (args.length < 2) { this.missing('group'); return; }
    const [name, style] = args;
    const url = page('group');
    const known = (g) => st.groups.has(g) || st.uncertain || st.fromRestart || isUnknown(g);
    if (style === 'delete') {
      if (args.length !== 2) { this.error('bad-args', 'Illegal group delete command: too many arguments'); return; }
      if (!st.groups.has(name) && !known(name)) { this.error('undefined-group', `Could not find group delete group ID ${name}`, null, { url }); return; }
      if (name === 'all') { this.error('bad-args', 'Cannot delete group all'); return; }
      for (const [fid, f] of st.fixes) if (f.group === name) { this.error('group-in-use', `Cannot delete group ${name} currently used by fix ID ${fid}`, null, { url, related: [f.line] }); return; }
      for (const [cid, c] of st.computes) if (c.group === name) { this.error('group-in-use', `Cannot delete group ${name} currently used by compute ID ${cid}`, null, { url, related: [c.line] }); return; }
      for (const [did, d] of st.dumps) if (d.group === name) { this.error('group-in-use', `Cannot delete group ${name} currently used by dump ID ${did}`, null, { url, related: [d.line] }); return; }
      st.groups.delete(name);
      return;
    }
    if (style === 'clear') {
      if (!known(name)) { this.error('undefined-group', `Could not find group clear group ID ${name}`, null, { url }); return; }
      if (name === 'all') this.error('bad-args', 'Cannot clear group all');
      return;
    }
    if (!st.groups.has(name) && st.groups.size >= 32) {
      this.error('too-many-groups', 'Too many groups (max 32)', 'LAMMPS allows at most 32 groups (all included), so it stops. Delete groups you no longer need with "group ID delete".', { url });
      return;
    }
    const fail = (lammps, message) => { this.error('group-args', lammps, message, { url }); };
    switch (style) {
      case 'region':
        if (args.length !== 3) { fail('Illegal group region command'); return; }
        if (!st.regions.has(args[2]) && !st.uncertain && !isUnknown(args[2])) {
          fail(`Region ${args[2]} for group region does not exist`, `group ${name} region uses region "${args[2]}", which is not defined, so LAMMPS stops. Define the region first.`);
          return;
        }
        break;
      case 'empty':
        if (args.length !== 2) { fail('Illegal group empty command'); return; }
        break;
      case 'type': case 'molecule': case 'id': {
        if (args.length < 3) { this.missing(`group ${style}`, url); return; }
        if (style === 'molecule' && !st.atomProps.mol && st.atomStyle) {
          fail('Group molecule command requires atom attribute molecule', `atom_style ${st.atomStyle} has no molecule IDs, so LAMMPS stops.`);
          return;
        }
        const ops = ['<', '>', '<=', '>=', '==', '!=', '<>'];
        if (args.length > 3 && ops.includes(args[2])) {
          if ((args[2] === '<>' && args.length !== 5) || (args[2] !== '<>' && args.length !== 4)) { fail('Illegal group command'); return; }
          for (const w of args.slice(3)) if (!(style === 'type' && !/^[-+]?\d+$/.test(w) && !isUnknown(w)) && !this.need('int', w)) return;
        } else {
          for (const w of args.slice(2)) {
            if (isUnknown(w)) continue;
            if (style === 'type' && /^\d*\*\d*$/.test(w)) continue;
            if (!/^-?\d+(:-?\d+(:\d+)?)?$/.test(w) && !(style === 'type' && /^[A-Za-z]/.test(w))) {
              fail(`Incorrect range string '${w}'`, `"${w}" is not a ${style} number or a range like 1:10 or 1:10:2, so LAMMPS stops.`);
              return;
            }
            if (style === 'type' && /^\d+$/.test(w) && st.ntypes && Number(w) > st.ntypes) {
              this.warn('group-type-range', `Atom type ${w} does not exist (the box has ${PLURAL(st.ntypes, 'type')}), so no atom joins group ${name} through it.`, { url });
            }
          }
        }
        break;
      }
      case 'variable': {
        const v = this.vars.get(args[2]);
        if (!v) { if (!st.uncertain) fail(`Variable name ${args[2]} for group does not exist`, `group ${name} variable uses "${args[2]}", which is not defined, so LAMMPS stops.`); break; }
        if (v.style !== 'atom' && v.style !== 'atomfile') { fail(`Variable ${args[2]} for group is invalid style`, `group variable needs an atom-style variable; "${args[2]}" is ${v.style}-style, so LAMMPS stops.`); return; }
        break;
      }
      case 'include':
        if (args.length !== 3) { fail('Illegal group include command'); return; }
        if (args[2] !== 'molecule') { fail(`Unknown group include keyword ${args[2]}`); return; }
        if (!st.atomProps.mol && st.atomStyle) { fail('Group include molecule command requires atom attribute molecule'); return; }
        break;
      case 'subtract': case 'union': case 'intersect': {
        if (args.length < (style === 'union' ? 3 : 4)) { this.missing(`group ${style}`, url); return; }
        for (const g of args.slice(2)) {
          if (!known(g)) {
            fail(`Group ID ${g} does not exist`, `group ${name} ${style} uses group "${g}", which is not defined at this point, so LAMMPS stops.`);
            return;
          }
          if (st.groups.get(g) && st.groups.get(g).dynamic) { fail(style === 'subtract' ? 'Cannot subtract dynamic groups' : style === 'union' ? 'Cannot union groups from a dynamic group' : 'Cannot intersect groups using a dynamic group'); return; }
        }
        break;
      }
      case 'dynamic':
        if (args.length < 4) { fail('Illegal group command'); return; }
        if (args[0] === args[2]) { fail('Group dynamic cannot reference itself'); return; }
        if (!known(args[2])) { fail(`Group dynamic parent group ${args[2]} does not exist`); return; }
        if (name === 'all') { fail('Group all cannot be made dynamic'); return; }
        st.groups.set(name, { line: this.entry.line, dynamic: true });
        this.checkSpec('group dynamic', args);
        return;
      case 'static':
        if (args.length !== 2) { fail('Illegal group static command'); return; }
        if (st.groups.has(name)) st.groups.get(name).dynamic = false;
        break;
      default:
        if (isUnknown(style)) break;
        fail(`Unknown group command keyword: ${style}`, `"${style}" is not a way to choose atoms for a group, so LAMMPS stops. ` +
          'Use region, type, id, molecule, variable, include, subtract, union, intersect, dynamic, static, empty, delete or clear.');
        return;
    }
    if (!st.groups.has(name)) st.groups.set(name, { line: this.entry.line });
  },

  c_velocity(args) {
    const st = this.st;
    if (!this.requireBox('velocity')) return;
    if (args.length < 2) { this.missing('velocity'); return; }
    if (!st.groups.has(args[0]) && !st.uncertain && !st.fromRestart && !isUnknown(args[0])) {
      this.error('undefined-group', `Could not find velocity group ID ${args[0]}`, `velocity uses group "${args[0]}", which is not defined, so LAMMPS stops.`, { url: page('velocity') });
      return;
    }
    if (!this.massesComplete('velocity')) return;
    const vstyle = args[1];
    if (!['create', 'set', 'scale', 'ramp', 'zero'].includes(vstyle) && !isUnknown(vstyle)) {
      this.error('unknown-keyword', `Unknown velocity keyword: ${vstyle}`, `"${vstyle}" is not a velocity style; use create, set, scale, ramp or zero, so LAMMPS stops.`);
      return;
    }
    const r = this.checkSpec(isUnknown(vstyle) ? 'velocity' : `velocity ${vstyle}`, args);
    if (r === null) return;
    if (args[1] === 'create') {
      const seed = args[3];
      st.velocityCreated = { line: this.entry.line, temp: args[2], seed };
      (st.seeds || (st.seeds = [])).push({ seed, line: this.entry.line, what: 'velocity create' });
    }
  }
});

/* ---- fixes, computes, dumps ---- */

/* Fixes that move atoms (they set time_integrate in LAMMPS). */
const INTEGRATOR_RE = /^(nve|nvt|npt|nph)(\/|$)|^rigid|^(move|nvk|gld|gle|brownian|brownian\/sphere|brownian\/asphere|tfmc|ffl|pafi|sph|mvv\/dpd|mvv\/tdpd|mvv\/edpd|meso\/move|python\/move|rheo|poems|msst|qbmsst|bocs|tgnvt\/drude|tgnpt\/drude|pimd\/langevin|pimd\/nvt|smd\/integrate_tlsph|smd\/integrate_ulsph|smd\/move_tri_surf|npt\/cauchy|ehex)$/;
const NOT_INTEGRATOR = new Set(['nve/noforce']);
const isIntegrator = (style) => {
  const b = baseStyle(style);
  return (INTEGRATOR_RE.test(b) || NOT_INTEGRATOR.has(b)) && b !== 'ehex';
};

Object.assign(Machine.prototype, {
  knownGroup(g) {
    const st = this.st;
    return st.groups.has(g) || st.uncertain || st.fromRestart || isUnknown(g);
  },

  c_fix(args) {
    const st = this.st;
    if (args.length < 3) { this.missing('fix'); return; }
    const [id, group, style] = args;
    this.url = lammpsDocUrl('fix', style) || page('fix');
    if (!st.box && !FIX_BEFORE_BOX.has(style)) { this.requireBox('fix'); return; }
    if (!this.knownGroup(group)) {
      const near = didYouMeanIn(group, [...st.groups.keys()]);
      this.error('undefined-group', `Could not find fix group ID ${group}`,
        `fix ${id} acts on group "${group}", which is not defined at this point, so LAMMPS stops.${near ? ` Did you mean ${near}?` : ' Define it with a group command first.'}`);
      return;
    }
    const old = st.fixes.get(id);
    if (old && old.style !== style && !this.sameWithSuffix(old.style, style)) {
      this.error('fix-replace-style', 'Replacing a fix, but new style != old style',
        `Fix ID "${id}" is already a fix ${old.style} (line ${old.line}); a fix can be redefined only with the same style, so LAMMPS stops. ` +
        `Use another ID, or "unfix ${id}" first.`, { related: [old.line] });
      return;
    }
    if (old && old.group !== group) this.warn('fix-replace-group', `Fix ${id} is redefined on group ${group} instead of ${old.group}; LAMMPS warns ("Replacing a fix, but new group != old group").`, { related: [old.line] });
    if (!this.checkStyle('fix', style, 'fix')) {
      st.fixes.set(id, { style, group, line: this.entry.line, args, broken: true });
      return;
    }
    if (!isId(id) && !isUnknown(id)) { this.error('bad-id', 'Fix ID must be alphanumeric or underscore characters', `"${id}" is not a valid fix ID: use letters, digits and underscores, so LAMMPS stops.`); return; }
    const fix = { style, group, line: this.entry.line, file: this.entry.file, args, integrates: isIntegrator(style) };
    if (old) this.dropCreated(id);
    st.fixes.set(id, fix);
    for (const c of FIX_CREATES[baseStyle(style)] || []) {
      const cid = c.replace('<ID>', id);
      if (st.computes.has(cid)) {
        this.error('compute-reuse', `Reuse of compute ID '${cid}'`, `fix ${style} makes a compute named ${cid} for itself, and a compute with that ID already exists (line ${st.computes.get(cid).line}), so LAMMPS stops.`,
          { related: [st.computes.get(cid).line] });
        fix.broken = true;
        return;
      }
      st.computes.set(cid, { style: /press/.test(cid) ? 'pressure' : /_pe$/.test(cid) ? 'pe' : 'temp', group: /press|_temp$/.test(cid) && /^(npt|nph|press|box|rigid\/np|plumed|bond)/.test(style) ? 'all' : group, line: this.entry.line, byFix: id });
    }
    const pre = FIX_PARSE[baseStyle(style)];
    let opts = {};
    if (pre) {
      opts = pre.call(this, args, fix, baseStyle(style));
      if (opts === null) { fix.broken = true; return; }
    }
    const r = this.checkSpec(`fix ${baseStyle(style)}`, args, opts);
    if (r === null) { fix.broken = true; return; }
    fix.kw = r.kw;
    fix.pos = r.pos;
    const extra = FIX_RULES[baseStyle(style)];
    if (extra && extra.call(this, fix, r, args) === false) fix.broken = true;
  },

  sameWithSuffix(a, b) {
    return baseStyle(a) === baseStyle(b) && (a === b || (this.st.suffix && this.st.suffixOn));
  },

  c_unfix(args) {
    if (args.length !== 1) { this.error('bad-args', 'Illegal unfix command'); return; }
    const id = args[0];
    if (!this.st.fixes.has(id)) {
      if (this.st.uncertain || isUnknown(id)) return;
      const near = didYouMeanIn(id, [...this.st.fixes.keys()]);
      this.error('undefined-fix', `Could not find fix ID ${id} to delete`, `There is no fix "${id}" to remove at this point, so LAMMPS stops.${near ? ` Did you mean ${near}?` : ''}`, { url: page('unfix') });
      return;
    }
    this.dropCreated(id);
    this.st.fixes.delete(id);
  },

  /* A fix deletes the computes it made when it goes. */
  dropCreated(id) {
    for (const [cid, c] of this.st.computes) if (c.byFix === id) this.st.computes.delete(cid);
  },

  c_fix_modify(args) {
    if (args.length < 2) { this.missing('fix_modify'); return; }
    if (!this.st.fixes.has(args[0])) {
      if (this.st.uncertain || isUnknown(args[0])) return;
      this.error('undefined-fix', `Could not find fix_modify ID ${args[0]}`, `There is no fix "${args[0]}" at this point, so LAMMPS stops.`, { url: page('fix_modify') });
      return;
    }
    this.checkSpec('fix_modify', args);
    const t = args.indexOf('temp');
    if (t > 0 && args[t + 1] && !this.st.computes.has(args[t + 1]) && !this.st.uncertain && !isUnknown(args[t + 1])) {
      this.error('undefined-compute', `Could not find fix_modify temperature compute ID: ${args[t + 1]}`, `fix_modify ${args[0]} temp names compute "${args[t + 1]}", which is not defined, so LAMMPS stops.`, { url: page('fix_modify') });
    }
  },

  c_compute(args) {
    const st = this.st;
    if (args.length < 3) { this.missing('compute'); return; }
    const [id, group, style] = args;
    this.url = lammpsDocUrl('compute', style) || page('compute');
    if (st.computes.has(id)) {
      const old = st.computes.get(id);
      this.error('compute-reuse', `Reuse of compute ID '${id}'`,
        `Compute "${id}" already exists (${old.auto ? 'LAMMPS makes it for thermo output' : `line ${old.line}`}); compute IDs cannot be redefined, so LAMMPS stops. ` +
        `Use another ID, or "uncompute ${id}" first.`, { related: old.auto ? [] : [old.line] });
      return;
    }
    if (!this.checkStyle('compute', style, 'compute')) { st.computes.set(id, { style, group, line: this.entry.line, broken: true }); return; }
    if (!isId(id) && !isUnknown(id)) { this.error('bad-id', 'Compute ID must be alphanumeric or underscore characters', `"${id}" is not a valid compute ID: use letters, digits and underscores, so LAMMPS stops.`); return; }
    if (!this.knownGroup(group)) {
      this.error('undefined-group', 'Could not find compute group ID', `compute ${id} acts on group "${group}", which is not defined at this point, so LAMMPS stops.`);
      return;
    }
    const c = { style, group, line: this.entry.line, file: this.entry.file, args };
    st.computes.set(id, c);
    const r = this.checkSpec(`compute ${baseStyle(style)}`, args);
    if (r === null) { c.broken = true; return; }
    const extra = COMPUTE_RULES[baseStyle(style)];
    if (extra) extra.call(this, c, r, args);
  },

  c_uncompute(args) {
    if (args.length !== 1) { this.error('bad-args', 'Illegal uncompute command'); return; }
    if (!this.st.computes.has(args[0])) {
      if (this.st.uncertain || isUnknown(args[0])) return;
      this.error('undefined-compute', `Could not find compute ID ${args[0]} to delete`, `There is no compute "${args[0]}" to remove at this point, so LAMMPS stops.`, { url: page('uncompute') });
      return;
    }
    this.st.computes.delete(args[0]);
  },

  c_compute_modify(args) {
    if (args.length < 2) { this.missing('compute_modify'); return; }
    if (!this.st.computes.has(args[0])) {
      if (this.st.uncertain || isUnknown(args[0])) return;
      this.error('undefined-compute', `Could not find compute_modify ID ${args[0]}`, `There is no compute "${args[0]}" at this point, so LAMMPS stops.`, { url: page('compute_modify') });
      return;
    }
    const c = this.st.computes.get(args[0]);
    const info = commandInfo('compute', c.style);
    if (!info || !info.package) this.checkSpec('compute_modify', args);
  },

  c_dump(args) {
    const st = this.st;
    if (args.length < 5) { this.error('bad-args', 'Illegal dump command', 'dump needs at least an ID, a group, a style, how often (N steps) and a file name, so LAMMPS stops.', { url: page('dump') }); return; }
    const [id, group, style, every] = args;
    this.url = lammpsDocUrl('dump', style) || page('dump');
    if (st.dumps.has(id)) {
      this.error('dump-reuse', `Reuse of dump ID: ${id}`, `Dump "${id}" already exists (line ${st.dumps.get(id).line}), so LAMMPS stops. Use another ID, or "undump ${id}" first.`, { related: [st.dumps.get(id).line] });
      return;
    }
    if (!this.knownGroup(group)) { this.error('undefined-group', `Could not find dump group ID: ${group}`, `dump ${id} writes group "${group}", which is not defined at this point, so LAMMPS stops.`); return; }
    if (!isUnknown(every) && !every.startsWith('v_') && !(isLammpsInteger(every) && Number(every) > 0)) {
      this.error('bad-value', `Invalid dump frequency ${every}`, `How often to write ("${every}") must be a positive number of steps, so LAMMPS stops.`);
      return;
    }
    if (!this.checkStyle('dump', style, 'dump')) return;
    const d = { style, group, every: isLammpsInteger(every) ? Number(every) : null, file: args[4], line: this.entry.line, args };
    const extra = DUMP_RULES[baseStyle(style)];
    if (extra) { if (extra.call(this, d, args, baseStyle(style)) === false) return; }
    else if (this.checkSpec(`dump ${baseStyle(style)}`, args) === null) return;
    st.dumps.set(id, d);
  },

  c_undump(args) {
    if (args.length !== 1) { this.error('bad-args', 'Illegal undump command'); return; }
    if (!this.st.dumps.has(args[0])) {
      if (this.st.uncertain || isUnknown(args[0])) return;
      this.error('undefined-dump', `Could not find undump ID: ${args[0]}`, `There is no dump "${args[0]}" to remove at this point, so LAMMPS stops.`, { url: page('undump') });
      return;
    }
    this.st.dumps.delete(args[0]);
  },

  c_dump_modify(args) {
    if (args.length < 2) { this.missing('dump_modify'); return; }
    const d = this.st.dumps.get(args[0]);
    if (!d) {
      if (this.st.uncertain || isUnknown(args[0])) return;
      this.error('undefined-dump', `Could not find dump_modify ID: ${args[0]}`, `There is no dump "${args[0]}" at this point, so LAMMPS stops.`, { url: page('dump_modify') });
      return;
    }
    this.checkSpec('dump_modify', args);
  }
});

/* Computes a fix makes for itself (<ID> is the fix ID). */
const FIX_CREATES = {
  'bond/swap': ['<ID>_temp'],
  'box/relax': ['<ID>_temp','<ID>_press'],
  'nph': ['<ID>_temp','<ID>_press'],
  'npt': ['<ID>_temp','<ID>_press'],
  'nvt': ['<ID>_temp'],
  'nvt/sllod': ['<ID>_temp'],
  'plumed': ['plmd_pe','plmd_press'],
  'press/berendsen': ['<ID>_temp','<ID>_press'],
  'rigid/nph': ['<ID>_temp','<ID>_press'],
  'rigid/nph/small': ['<ID>_temp','<ID>_press'],
  'rigid/npt': ['<ID>_temp','<ID>_press'],
  'rigid/npt/small': ['<ID>_temp','<ID>_press'],
  'temp/berendsen': ['<ID>_temp'],
  'temp/csld': ['<ID>_temp'],
  'temp/csvr': ['<ID>_temp'],
  'temp/rescale': ['<ID>_temp'],
  'tgnvt/drude': ['<ID>_temp']
};

/*
 * Fixes whose arguments are not a fixed list plus keywords: they read a
 * list of values (c_ID, f_ID, v_name, per-atom names) until the first word
 * that is not one, then keywords. Each returns the options for checkSpec,
 * or null after reporting where LAMMPS stops.
 */
const PERATOM_VALUES = 'id|mol|type|mass|x|y|z|xs|ys|zs|xu|yu|zu|xsu|ysu|zsu|ix|iy|iz|vx|vy|vz|fx|fy|fz|q|mux|muy|muz|mu|radius|diameter|omegax|omegay|omegaz|angmomx|angmomy|angmomz|tqx|tqy|tqz';
const AVE_VALUES = {
  'ave/time': { n: 3, re: /^[cfv]_/, none: 'No values from computes, fixes, or variables used in fix ave/time command' },
  'ave/chunk': { n: 4, re: /^([cfv]_|(vx|vy|vz|fx|fy|fz|density\/number|density\/mass|mass|temp)$)/, none: 'No values in fix ave/chunk command' },
  'ave/histo': { n: 6, re: /^([cfv]_|(x|y|z|vx|vy|vz|fx|fy|fz)$)/, none: 'No values in fix ave/histo command' },
  'ave/histo/weight': { n: 6, re: /^([cfv]_|(x|y|z|vx|vy|vz|fx|fy|fz)$)/, none: 'No values in fix ave/histo/weight command' },
  'ave/correlate': { n: 3, re: /^[cfv]_/, none: null },
  'ave/correlate/long': { n: 3, re: /^[cfv]_/, none: null },
  'ave/atom': { n: 3, re: new RegExp(`^([cfv]_|[di]2?_|(${PERATOM_VALUES})$)`), none: null, all: 'Invalid fix ave/atom argument: {arg}' },
  'store/state': { n: 1, re: new RegExp(`^([cfv]_|[di]2?_|(${PERATOM_VALUES})$)`), none: null }
};

function aveValues(args, fix, style) {
  const a = AVE_VALUES[style];
  let i = 3 + a.n;
  const values = [];
  while (i < args.length && (a.re.test(args[i]) || isUnknown(args[i]))) values.push(args[i++]);
  if (a.all && i < args.length) {
    const lammps = a.all.replace('{arg}', args[i]);
    this.error('bad-value', lammps, `"${args[i]}" is not a value fix ${style} can average (per-atom names such as x or vx, c_ID, f_ID or v_name), so LAMMPS stops.`);
    return null;
  }
  if (!values.length && a.none && args.length > 3 + a.n) {
    this.error('no-values', a.none, `fix ${style} needs at least one value to average (c_ID, f_ID or v_name${style === 'ave/time' ? '' : ', or a per-atom name'}) after its numbers; "${args[3 + a.n]}" is not one, so LAMMPS stops.`);
    return null;
  }
  fix.values = values;
  return { kwStart: i };
}

const FIX_PARSE = {
  'ave/time': aveValues, 'ave/chunk': aveValues, 'ave/histo': aveValues, 'ave/histo/weight': aveValues,
  'ave/correlate': aveValues, 'ave/correlate/long': aveValues, 'ave/atom': aveValues, 'store/state': aveValues,
  shake: shakeLists, rattle: shakeLists,
  // fix gravity magnitude chute angle | spherical phi theta | vector x y z, then keywords.
  gravity(args) { return { kwStart: 5 + ({ chute: 1, spherical: 2, vector: 3 }[args[4]] || 0) }; },
  rigid: rigidBodies, 'rigid/nve': rigidBodies, 'rigid/nvt': rigidBodies, 'rigid/npt': rigidBodies, 'rigid/nph': rigidBodies,
  'rigid/small': rigidBodies, 'rigid/nve/small': rigidBodies, 'rigid/nvt/small': rigidBodies, 'rigid/npt/small': rigidBodies, 'rigid/nph/small': rigidBodies
};

/* fix shake/rattle: tol iter N, then b/a/t/m lists until mol or kbond. */
function shakeLists(args, fix, style) {
  const st = this.st;
  if (st.atomStyle && !st.atomProps.mol && !st.fromRestart) {
    this.error('shake-atomic', `Cannot use fix ${style} with non-molecular system`, `fix ${style} constrains bonds, and atom_style ${st.atomStyle} has none, so LAMMPS stops.`, { related: [st.atomStyleLine] });
    return null;
  }
  if (args.length < 8) return {};
  let i = 6;
  let mode = '';
  const lists = { b: [], a: [], t: [], m: [] };
  for (; i < args.length; i++) {
    const w = args[i];
    if (isUnknown(w)) continue;
    if (w === 'b' || w === 'a' || w === 't' || w === 'm') { mode = w; continue; }
    if (w === 'mol' || w === 'kbond') break;
    if (!mode) {
      this.error('unknown-keyword', `Unknown fix ${style} command option: ${w}`, `After tolerance, iterations and N, fix ${style} expects b, a, t or m followed by types (or a mass); "${w}" is none of them, so LAMMPS stops.`);
      return null;
    }
    const type = mode === 'm' ? 'num' : 'int';
    const p = typeProblem(type, w);
    if (p) { this.error('bad-value', p, `fix ${style} ${mode} list: "${w}" is not ${typeWords[type]}, so LAMMPS stops. The list ends only at mol or kbond.`); return null; }
    lists[mode].push(Number(w));
  }
  if (lists.m.length && !this.massesComplete(`fix ${style}`)) return null;
  if (lists.m.some(x => x === 0)) { this.error('bad-value', `Invalid atom mass 0 for ${style}`, `A mass of 0 cannot select atoms, so LAMMPS stops.`); return null; }
  if (st.ntypes && lists.t.some(t => t < 1 || t > st.ntypes)) {
    const t = lists.t.find(x => x < 1 || x > st.ntypes);
    this.error('bad-type', `Invalid atom type ${t} for fix ${style}`, `Atom type ${t} does not exist (the box has ${PLURAL(st.ntypes, 'type')}), so LAMMPS stops.`);
    return null;
  }
  fix.shake = lists;
  return { kwStart: i };
}

/* fix rigid*: the body style and its words, then keywords. */
function rigidBodies(args, fix, style) {
  const small = /small$/.test(style);
  const body = args[3];
  if (body === undefined || isUnknown(body)) return {};
  let i = 4;
  if (body === 'molecule') {
    if (this.st.atomStyle && !this.st.atomProps.mol && !this.st.fromRestart) {
      this.error('rigid-molecule', small ? 'Fix rigid/small requires atom attribute molecule' : 'Fix rigid molecule requires atom attribute molecule',
        `The bodies are molecules, but atom_style ${this.st.atomStyle} has no molecule IDs, so LAMMPS stops.`, { related: [this.st.atomStyleLine] });
      return null;
    }
  } else if (body === 'custom') i = 5;
  else if (body === 'group' && !small) {
    const n = Number(args[4]);
    if (args[4] === undefined || !Number.isFinite(n)) return {};
    for (const g of args.slice(5, 5 + n)) {
      if (!this.knownGroup(g)) { this.error('undefined-group', `Could not find fix ${style} group ID ${g}`, `fix ${style} group uses group "${g}", which is not defined, so LAMMPS stops.`); return null; }
    }
    i = 5 + n;
  }
  return { kwStart: i };
}

/* Style-specific checks run after the argument table: (fix, result, args). */
const FIX_RULES = {};

/* Charge equilibration sets the charges as the run goes. */
for (const k of ['qeq/reaxff', 'qeq/point', 'qeq/shielded', 'qeq/slater', 'qeq/dynamic', 'qeq/fire', 'acks2/reaxff', 'qeq/comb', 'qtpie/reaxff']) {
  FIX_RULES[k] = function charges() { this.st.charges = null; };
}

/* Thermostats with random numbers: remember the seed. */
for (const k of ['langevin', 'temp/csvr', 'temp/csld', 'langevin/drude']) {
  FIX_RULES[k] = function seed(fix, r, args) {
    const at = k === 'langevin' ? 6 : 6;
    (this.st.seeds || (this.st.seeds = [])).push({ seed: args[at], line: this.entry.line, what: `fix ${k}` });
  };
}

/* fix property/atom gives atoms a molecule ID, charge or mass of their own. */
FIX_RULES['property/atom'] = function propertyAtom(fix, r, args) {
  const p = this.st.atomProps;
  for (const w of args.slice(3)) {
    if (w === 'mol') p.mol = true;
    else if (w === 'q') p.q = true;
    else if (w === 'rmass') p.rmass = true;
  }
};

/* After the keywords: the timing of fix ave/* and the IDs they read. */
function aveChecks(fix, r, args) {
  const style = baseStyle(fix.style);
  const st = this.st;
  if (style !== 'store/state') {
    const [ne, nr, nf] = args.slice(3, 6).map(Number);
    if (![ne, nr, nf].some(Number.isNaN) && !args.slice(3, 6).some(isUnknown)) {
      if (ne <= 0) { this.error('bad-value', `Illegal fix ${style} nevery value: ${ne}`); return false; }
      if (nr <= 0) { this.error('bad-value', `Illegal fix ${style} nrepeat value: ${nr}`); return false; }
      if (nf <= 0) { this.error('bad-value', `Illegal fix ${style} nfreq value: ${nf}`); return false; }
      if (style !== 'ave/correlate' && style !== 'ave/correlate/long' && (nf % ne !== 0 || nr * ne > nf)) {
        this.error('ave-timing', `Inconsistent fix ${style} nevery/nrepeat/nfreq values`,
          `fix ${style} averages Nrepeat = ${nr} samples taken every Nevery = ${ne} steps and reports every Nfreq = ${nf} steps; Nfreq must be a multiple of Nevery and at least Nevery × Nrepeat (${ne * nr}), so LAMMPS stops.`,
          { url: page(`fix_${style.replace(/\//g, '_')}`) });
        return false;
      }
      fix.nfreq = nf;
    }
  }
  if (style === 'ave/chunk') {
    const cid = args[6];
    const c = st.computes.get(cid);
    if (!st.uncertain && !isUnknown(cid) && (!c || baseStyle(c.style) !== 'chunk/atom')) {
      this.error('undefined-compute', `Chunk/atom compute ${cid} does not exist or is not chunk/atom style`, `fix ave/chunk needs a compute chunk/atom to sort atoms into chunks; "${cid}" is not one, so LAMMPS stops.`, { url: page('compute_chunk_atom') });
      return false;
    }
  }
  return this.valueRefs(fix.values || [], `fix ${style}`);
}
for (const k of Object.keys(AVE_VALUES)) FIX_RULES[k] = aveChecks;

Object.assign(Machine.prototype, {
  /* c_ID, f_ID and v_name in a value list must exist; LAMMPS stops otherwise. */
  valueRefs(values, who) {
    const st = this.st;
    if (st.uncertain) return true;
    for (const v of values) {
      const m = /^([cfv])_([^[\]]+)/.exec(v);
      if (!m) continue;
      const name = m[2];
      if (m[1] === 'c' && !st.computes.has(name)) {
        this.error('undefined-compute', `Compute ID ${name} for ${who} does not exist`, `${who} reads c_${name}, but no compute "${name}" is defined at this point, so LAMMPS stops. Define the compute before this line.`);
        return false;
      }
      if (m[1] === 'f' && !st.fixes.has(name) && !st.fromRestart) {
        this.error('undefined-fix', `Fix ID ${name} for ${who} does not exist`, `${who} reads f_${name}, but no fix "${name}" is defined at this point, so LAMMPS stops. Define the fix before this line.`);
        return false;
      }
      if (m[1] === 'v' && !this.vars.has(name)) {
        this.error('undefined-variable', `Variable name ${name} for ${who} does not exist`, `${who} reads v_${name}, but no variable "${name}" is defined at this point, so LAMMPS stops. Define the variable before this line.`);
        return false;
      }
    }
    return true;
  }
});
const COMPUTE_RULES = {};
const DUMP_RULES = {};

/* What each per-atom attribute needs from the atom style. */
const DUMP_NEEDS = { mol: 'mol', q: 'q', mux: 'mu', muy: 'mu', muz: 'mu', mu: 'mu', radius: 'radius', diameter: 'radius' };

/* dump custom, yaml, cfg: per-atom columns, and c_ID, f_ID, v_name that must exist. */
function dumpColumns(d, args, style) {
  const st = this.st;
  const spec = specFor(`dump ${style}`);
  const names = new Set(Object.keys((spec && spec.kw) || {}));
  const words = args.slice(5);
  if (!words.length) {
    this.error('missing-args', `No dump ${style} arguments specified`, `dump ${style} needs the columns to write after the file name (e.g. id type x y z), so LAMMPS stops.`);
    return false;
  }
  if (style === 'cfg') {
    const want = ['mass', 'type', 'xs|xsu', 'ys|ysu', 'zs|zsu'];
    for (let k = 0; k < 5; k++) {
      if (!isUnknown(words[k] || '') && !want[k].split('|').includes(words[k])) {
        this.error('bad-value', 'Dump cfg arguments must start with \'mass type xs ys zs\' or \'mass type xsu ysu zsu\'', null);
        return false;
      }
    }
  }
  for (const w of words) {
    if (isUnknown(w)) continue;
    if (names.has(w)) {
      const need = DUMP_NEEDS[w];
      if (need && st.atomStyle && ATOM_STYLES[st.atomStyle] && !st.atomProps[need] && !st.fromRestart && !st.uncertain) {
        this.error('dump-property', "Dumping an atom property that isn't allocated",
          `Column ${w} needs atoms that carry it, and atom_style ${st.atomStyle} does not, so LAMMPS stops.`, { related: [st.atomStyleLine] });
        return false;
      }
      continue;
    }
    const m = /^([cfv]|[di]2?)_([^[\]]+)((\[[^\]]*\])*)$/.exec(w);
    if (!m) {
      const near = didYouMeanIn(w, [...names]);
      this.error('dump-column', `Invalid attribute ${w} in dump ${style} command`, `"${w}" is not something dump ${style} can write, so LAMMPS stops.${near ? ` Did you mean ${near}?` : ''}`);
      return false;
    }
    if (st.uncertain) continue;
    const [, kind, name] = m;
    if (kind === 'c') {
      const c = st.computes.get(name);
      if (!c) { this.error('undefined-compute', `Could not find dump ${style} compute ID: ${name}`, `Column c_${name} reads compute "${name}", which is not defined at this point, so LAMMPS stops. Define the compute before the dump.`); return false; }
      const shape = COMPUTE_SHAPES[baseStyle(c.style)];
      if (shape && !shape.includes('peratom') && !shape.includes('?')) {
        this.error('compute-shape', `Dump ${style} compute ${name} does not compute per-atom info`, `compute ${name} (${c.style}) gives ${shapeWords(shape)}, not one value per atom, so dump ${style} cannot write it; LAMMPS stops.`, { related: [c.line] });
        return false;
      }
    } else if (kind === 'f') {
      if (!st.fixes.has(name)) { this.error('undefined-fix', `Could not find dump ${style} fix ID: ${name}`, `Column f_${name} reads fix "${name}", which is not defined at this point, so LAMMPS stops.`); return false; }
    } else if (kind === 'v') {
      const v = this.vars.get(name);
      if (!v) { this.error('undefined-variable', `Could not find dump ${style} variable name ${name}`, `Column v_${name} reads variable "${name}", which is not defined at this point, so LAMMPS stops.`); return false; }
      if (!['atom', 'atomfile'].includes(v.style)) { this.error('variable-style', `Dump ${style} variable ${name} is not atom-style variable`, `A dump column needs one value per atom; variable ${name} is ${v.style}-style, so LAMMPS stops.`, { related: [v.line] }); return false; }
    }
  }
  return true;
}
for (const k of ['custom', 'custom/gz', 'custom/zstd', 'yaml', 'cfg', 'cfg/gz', 'cfg/zstd']) DUMP_RULES[k] = dumpColumns;

/* dump local: index and c_ID or f_ID local values. */
DUMP_RULES.local = function dumpLocal(d, args) {
  const st = this.st;
  const words = args.slice(5);
  if (!words.length) { this.error('missing-args', 'No dump local arguments specified', 'dump local needs the values to write after the file name, so LAMMPS stops.'); return false; }
  for (const w of words) {
    if (isUnknown(w) || w === 'index') continue;
    const m = /^([cf])_([^[\]]+)/.exec(w);
    if (!m) { this.error('dump-column', `Invalid attribute ${w} in dump local command`, `dump local writes index and local values (c_ID or f_ID); "${w}" is neither, so LAMMPS stops.`); return false; }
    if (st.uncertain) continue;
    if (m[1] === 'c' && !st.computes.has(m[2])) { this.error('undefined-compute', `Could not find dump local compute ID ${m[2]}`, `Column ${w} reads compute "${m[2]}", which is not defined at this point, so LAMMPS stops.`); return false; }
    if (m[1] === 'f' && !st.fixes.has(m[2])) { this.error('undefined-fix', `Could not find dump local fix ID ${m[2]}`, `Column ${w} reads fix "${m[2]}", which is not defined at this point, so LAMMPS stops.`); return false; }
  }
  return true;
};

/* ---- runs and what LAMMPS checks when a run starts ---- */

/*
 * What a pair style leaves to kspace (its ewald, pppm, msm, dispersion and
 * tip4p flags), as a Set, or null when STEMKit does not know the style.
 */
function pairKspaceFlags(subs, pair) {
  if (!pair) return new Set();
  const out = new Set();
  for (const sub of subs) {
    const b = baseStyle(sub.style);
    if (b === 'none' || b === 'zero') continue;
    const info = PAIR_INFO[b];
    if (b === 'coul/streitz') {
      // coul/streitz cutoff wolf alpha | ewald: with ewald it leaves the long-range part to kspace.
      if ((sub.args || []).includes('ewald')) { out.add('ewald'); out.add('pppm'); }
      continue;
    }
    if (!info) {
      if (/coul\/long|coul\/msm|tip4p\/long|\/long\/|ewald|thole\/long|dipole\/long/.test(b)) return null;
      continue;
    }
    for (const f of (info.k || '').split(' ').filter(Boolean)) out.add(f);
    // lj/long/coul/long and friends: "long long" also leaves dispersion to kspace; "cut"/"off" do not.
    if (/^(lj|buck)\/long\/(coul|tip4p)\/long$/.test(b) && sub.args && sub.args[0] !== 'long') out.delete('dispersion');
  }
  if (out.size) out.add('coul');
  return out;
}

/* The flags a kspace style needs from the pair style (KSpace::pair_check). */
function KSPACE_FLAGS(style) {
  const b = baseStyle(style);
  if (/^ewald\/disp/.test(b)) return null;
  if (/^ewald\/dipole/.test(b)) return ['ewald', 'dipole'];
  if (/^ewald/.test(b)) return ['ewald'];
  if (/^pppm\/disp\/tip4p/.test(b)) return ['pppm', 'dispersion', 'tip4p'];
  if (/^pppm\/disp/.test(b)) return ['pppm', 'dispersion'];
  if (/^pppm\/tip4p/.test(b)) return ['pppm', 'tip4p'];
  if (/^pppm\/dipole/.test(b)) return null;
  if (/^pppm/.test(b)) return ['pppm'];
  if (/^msm/.test(b)) return ['msm'];
  return null;
}
/* Atom styles whose particles carry their own mass (AtomVec mass_type PER_ATOM). */
const PER_ATOM_MASS_STYLES = new Set(['sphere', 'ellipsoid', 'line', 'tri', 'body', 'bpm/sphere', 'peri', 'smd']);

Object.assign(Machine.prototype, {
  /* Atom::check_mass: every type needs a mass, unless masses are per atom. */
  massesComplete(where) {
    const st = this.st;
    if (st.fromRestart || st.uncertain || st.masses.has('*') || !st.ntypes) return true;
    if (PER_ATOM_MASS_STYLES.has(st.atomStyle)) return true;
    for (let t = 1; t <= st.ntypes; t++) {
      if (!st.masses.has(t)) {
        this.error('mass-missing', `Not all per-type masses are set. Type ${t} is missing.`,
          `Atom type ${t} has no mass (set masses with the mass command, or a Masses section in the data file), so LAMMPS stops ${where === 'run' ? 'when the run starts' : `at ${where}`}.`,
          { url: page('mass') });
        return false;
      }
    }
    return true;
  },

  c_run(args) {
    if (!this.requireBox('run')) return;
    if (!args.length) { this.missing('run'); return; }
    if (!this.need('bigint', args[0], 'number of steps')) return;
    const r = this.checkSpec('run', args);
    if (r === null) return;
    const steps = isUnknown(args[0]) ? null : Number(args[0]);
    if (steps !== null && steps < 0) { this.error('bad-value', `Invalid run command N value: ${steps}`, null); return; }
    this.startRun('run', steps);
    if (r.kw.has('every')) {
      const cmds = r.kw.get('every').slice(1);
      for (const c of cmds) if (c !== 'NULL') this.exec(this.entry, c, true);
    }
  },

  c_minimize(args) {
    if (!this.requireBox('minimize')) return;
    if (args.length !== 4) { this.error('bad-args', 'Illegal minimize command: expected 4 arguments but found ' + args.length, `minimize takes four values: energy tolerance, force tolerance, maximum iterations and maximum force evaluations; this line has ${args.length}, so LAMMPS stops.`); return; }
    if (!this.need('num', args[0], 'energy tolerance') || !this.need('num', args[1], 'force tolerance') || !this.need('int', args[2], 'maximum iterations') || !this.need('int', args[3], 'maximum force evaluations')) return;
    this.startRun('minimize', isUnknown(args[2]) ? null : Number(args[2]));
  },

  c_min_modify(args) {
    // Minimisers from packages (spin, ...) read keywords of their own.
    if (this.st.minStyle && !/^(cg|sd|hftn|quickmin|fire)$/.test(this.st.minStyle)) return;
    this.checkSpec('min_modify', args);
  },

  c_min_style(args) {
    if (!this.requireBox('min_style')) return;
    if (!args.length) { this.error('bad-args', 'Illegal min_style command'); return; }
    if (!this.checkStyle('min_style', args[0], 'minimize')) return;
    this.st.minStyle = args[0];
  },

  c_run_style(args) {
    if (!this.requireBox('run_style')) return;
    if (!args.length) { this.error('bad-args', 'Illegal run_style command'); return; }
    if (!this.checkStyle('run_style', args[0], 'integrate')) return;
    this.st.runStyle = args[0];
  },

  c_write_data(args) {
    if (!this.requireBox('write_data')) return;
    if (!args.length) { this.missing('write_data'); return; }
    if (this.checkSpec('write_data', args) === null) return;
    // write_data initialises the system (unless "noinit") as a run would.
    if (!args.includes('noinit')) this.initChecks('write_data');
  },

  c_write_restart(args) {
    if (!this.requireBox('write_restart')) return;
    if (!args.length) { this.missing('write_restart'); return; }
    if (this.checkSpec('write_restart', args) === null) return;
    if (!args.includes('noinit') && !this.initChecks('write_restart')) return;
    this.saveRestart(args[0], `write_restart (line ${this.entry.line}${this.entry.file ? ` of ${this.entry.file}` : ''})`);
  },

  c_restart(args) {
    if (!args.length) { this.missing('restart'); return; }
    // restart N file, or restart N file1 file2 (written in turn), then keywords.
    const two = args.length >= 3 && !/^(fileper|nfile|noinit)$/.test(args[2]);
    if (this.checkSpec('restart', args, { kwStart: two ? 3 : 2 }) === null) return;
    if (args[0] === '0' && args.length === 1) { this.st.restartEvery = null; return; }
    // restart N file, or restart N file1 file2 (written in turn).
    const files = args.slice(1).filter(a => !/^(fileper|nfile)$/.test(a) && !/^\d+$/.test(a));
    this.st.restartEvery = { line: this.entry.line, files: files.slice(0, 2) };
  },

  c_reset_timestep(args) {
    if (!args.length) { this.missing('reset_timestep'); return; }
    if (!this.need('bigint', args[0], 'timestep')) return;
    // Energies were tallied on the old step number, not the new one.
    this.st.energyStale = true;
  },

  startRun(kind, steps) {
    const st = this.st;
    st.currentRunSteps = steps;
    if (!this.initChecks(kind)) return;
    if (st.restartEvery) for (const f of st.restartEvery.files) this.saveRestart(f, `restart (line ${st.restartEvery.line})`);
    st.runs.push({ line: this.entry.line, file: this.entry.file, steps, kind });
    st.ran = true;
    for (const c of st.computes.values()) c.initialized = true;
    st.energyStale = false;
  },

  /*
   * What LAMMPS checks when it sets up a run (LAMMPS::init: force field,
   * masses, fixes, neighbours, output), in that order, then advice.
   */
  initChecks(kind) {
    const st = this.st;
    const atRun = kind === 'run' || kind === 'minimize';
    const where = atRun ? 'when the run starts' : `at ${kind}`;
    const pair = st.pair && !st.pair.broken ? st.pair : null;
    const kspace = st.kspace;
    const charged = st.atomProps.q || st.fromRestart || st.uncertain || st.atomStyle === null;
    if (st.uncertain) return this.massesComplete(atRun ? 'run' : kind) && this.outputReferences(where) && (this.adviseRun(kind), true);
    const subs = pair ? (/^hybrid/.test(pair.style) ? pair.subs : [{ style: pair.style, args: pair.args }]) : [];
    const flags = pairKspaceFlags(subs, pair);
    if (st.pairRestart && !pair) {
      this.error('pair-restart', `Must re-specify non-restarted pair style (${st.pairRestart}) after read_restart`,
        `pair_style ${st.pairRestart} does not store its parameters in restart files, so after read_restart the script must give pair_style and pair_coeff again; LAMMPS stops ${where}.`,
        { url: page('read_restart') });
      return false;
    }
    // KSpace is set up before the pair style (Force::init).
    if (kspace) {
      const kf = KSPACE_FLAGS(kspace.style);
      const needsQ = !/dipole|disp$/.test(baseStyle(kspace.style)) || /^(pppm|ewald)\/disp/.test(kspace.style) && flags && flags.has('coul');
      if (!charged && needsQ && !/dipole/.test(kspace.style) && !/disp/.test(kspace.style)) {
        this.error('kspace-no-charge', 'Kspace style requires atom attribute q',
          `kspace_style ${kspace.style} (line ${kspace.line}) needs charges, but atom_style ${st.atomStyle} has none, so LAMMPS stops ${where}. Use atom_style charge or full.`,
          { url: page('kspace_style'), related: [kspace.line, st.atomStyleLine] });
        return false;
      }
      if (!pair && !st.pairFromRestart) {
        this.error('kspace-no-pair', 'KSpace solver requires a pair style', `kspace_style ${kspace.style} (line ${kspace.line}) needs a pair style with long-range Coulomb, and there is no pair_style, so LAMMPS stops ${where}.`,
          { url: page('kspace_style'), related: [kspace.line] });
        return false;
      }
      if (pair && flags && kf) {
        const missing = kf.filter(f => !flags.has(f));
        const extra = ['dispersion', 'tip4p'].filter(f => flags.has(f) && !kf.includes(f));
        if (missing.length || extra.length) {
          const why = missing.includes('tip4p') ? `kspace_style ${kspace.style} needs a TIP4P pair style (e.g. lj/cut/tip4p/long)`
            : extra.includes('tip4p') ? `pair_style ${pair.style} is a TIP4P style, so it needs kspace_style pppm/tip4p`
            : missing.includes('dispersion') ? `kspace_style ${kspace.style} computes long-range dispersion, which pair_style ${pair.style} does not leave to it`
            : extra.includes('dispersion') ? `pair_style ${pair.style} leaves long-range dispersion to kspace, which ${kspace.style} does not compute (use pppm/disp or ewald/disp)`
            : missing.includes('msm') ? `kspace_style ${kspace.style} needs a pair style ending in coul/msm`
            : flags.has('msm') ? `pair_style ${pair.style} is made for kspace_style msm`
            : `kspace_style ${kspace.style} computes the long-range part of the Coulomb sum, but pair_style ${pair.style} has no long-range part for it to complete`;
          this.error('kspace-pair', 'KSpace style is incompatible with Pair style',
            `${why} (lines ${kspace.line} and ${pair.line}), so LAMMPS stops ${where}. ` +
            (missing.length && !flags.size ? 'Use a pair style ending in coul/long (e.g. lj/cut/coul/long) with kspace, or remove kspace_style.' : ''),
            { url: page('kspace_style'), related: [kspace.line, pair.line] });
          return false;
        }
      }
      if (st.charges === false && /^(pppm|ewald)(\/(cg|tip4p|stagger))?$/.test(baseStyle(kspace.style)) && !kspace.gewald) {
        const ewald = baseStyle(kspace.style) === 'ewald';
        this.error('kspace-uncharged', ewald ? "Must use 'kspace_modify gewald' for uncharged system" : 'Must use kspace_modify gewald for uncharged system',
          `The atoms made by create_atoms carry no charge (no "set ... charge" gives them any), so ${kspace.style} cannot choose its splitting parameter; LAMMPS warns "Using kspace solver on system with no charge" and stops ${where}. ` +
          'Set the charges (set type N charge q), or give kspace_modify gewald.',
          { url: page('kspace_modify'), related: [kspace.line] });
        return false;
      }
      if (/^(pppm|ewald)/.test(kspace.style) && st.boundary.some((b, d) => b !== 'p' && !(d === 2 && kspace.slab)) && st.boundary.join('') !== 'ppp') {
        const z = st.boundary[2] !== 'p' && st.boundary[0] === 'p' && st.boundary[1] === 'p';
        if (!z || !kspace.slab) {
          this.error('kspace-boundary', `Cannot use nonperiodic boundaries with ${kspace.style.startsWith('ewald') ? 'Ewald' : 'PPPM'}`,
            `${kspace.style} needs periodic boundaries in x, y and z${z ? ' (or kspace_modify slab 3.0 for a slab non-periodic in z)' : ''}, so LAMMPS stops ${where}.`,
            { url: page('kspace_modify'), related: [kspace.line] });
          return false;
        }
      }
    }
    if (pair) {
      for (const sub of subs) {
        const info = PAIR_INFO[baseStyle(sub.style)];
        if (!info || !info.q || charged) continue;
        if (/\/long\/(coul|tip4p)\/long$/.test(baseStyle(sub.style)) && sub.args && sub.args[1] === 'off') continue;
        this.error('pair-no-charge', info.q,
          `pair_style ${sub.style} (line ${pair.line}) computes Coulomb forces, but atom_style ${st.atomStyle} has no charges, so LAMMPS stops ${where}. Use atom_style charge or full, or a pair style without coul.`,
          { url: lammpsDocUrl('pair_style', sub.style), related: [pair.line, st.atomStyleLine] });
        return false;
      }
      if (flags && flags.size && !kspace && !st.fromRestart) {
        this.error('pair-no-kspace', 'Pair style requires a KSpace style',
          `pair_style ${pair.style} (line ${pair.line}) leaves the long-range part of the Coulomb (or dispersion) sum to a kspace solver, and there is no kspace_style, so LAMMPS stops ${where}. ` +
          'Add e.g. "kspace_style pppm 1.0e-4", or use a cut-off Coulomb style (coul/cut, coul/dsf).',
          { url: page('kspace_style'), related: [pair.line] });
        return false;
      }
      if (!this.pairCoeffsComplete(where)) return false;
    }
    if (!this.bondedComplete(where)) return false;
    if (!this.massesComplete(atRun ? 'run' : kind)) return false;
    if (!this.fixOrder(where)) return false;
    if (!this.outputReferences(where)) return false;
    this.adviseRun(kind);
    return true;
  },

  adviseRun(kind) {
    if (kind === 'run') this.runAdvice();
    else if (kind === 'minimize') this.minimizeAdvice();
  },

  /* Bond and dihedral styles that check the pair style and special_bonds when a run starts. */
  bondedComplete(where) {
    const st = this.st;
    if (st.fromRestart) return true;
    const sb = st.special;
    const bond = st.bonded.bond ? baseStyle(st.bonded.bond.style) : '';
    const dih = st.bonded.dihedral ? baseStyle(st.bonded.dihedral.style) : '';
    const pair = st.pair && !st.pair.broken ? baseStyle(st.pair.style) : 'none';
    if (/^(charmm|charmmfsw)$/.test(dih) && st.charmmWeight) {
      if (sb.lj[2] !== 0 || sb.coul[2] !== 0) {
        this.error('charmm-special', "Must use 'special_bonds charmm' with dihedral style charmm for use with CHARMM pair styles",
          `dihedral_style ${dih} with a non-zero 1-4 weight adds the 1-4 pair interactions itself, so the pair style must leave them out (special_bonds charmm, or lj/coul 0 0 0); LAMMPS stops ${where}.`,
          { url: page('dihedral_charmm'), related: [st.bonded.dihedral.line, sb.line].filter(Boolean) });
        return false;
      }
      if (!/^lj\/charmm(fsw)?\/coul\//.test(pair)) {
        this.error('charmm-pair', `Dihedral ${dih} is incompatible with Pair style`,
          `dihedral_style ${dih} with a non-zero 1-4 weight needs a CHARMM pair style (lj/charmm/coul/long, lj/charmmfsw/coul/long ...) for the 1-4 terms; pair_style ${pair} is not one, so LAMMPS stops ${where}.`,
          { url: page('dihedral_charmm'), related: [st.bonded.dihedral.line] });
        return false;
      }
    }
    if (dih === 'charmmfsw' && !/^lj\/charmmfsw\/coul\/(long|charmmfsh)$/.test(pair) && !st.uncertain) {
      this.error('charmm-pair', 'Dihedral charmmfsw is incompatible with Pair style',
        `dihedral_style charmmfsw works only with pair_style lj/charmmfsw/coul/long or lj/charmmfsw/coul/charmmfsh; pair_style ${pair} is neither, so LAMMPS stops ${where}.`,
        { url: page('dihedral_charmm'), related: [st.bonded.dihedral.line] });
      return false;
    }
    if (bond === 'quartic' && (sb.lj[0] !== 1 || sb.lj[1] !== 1 || sb.lj[2] !== 1)) {
      this.error('special-bonds', 'Bond style quartic requires special_bonds = 1,1,1', `bond_style quartic needs "special_bonds lj 1 1 1", so LAMMPS stops ${where}.`, { url: page('bond_quartic') });
      return false;
    }
    if (/^fene/.test(bond) && (sb.lj[0] !== 0 || sb.lj[1] !== 1 || sb.lj[2] !== 1) && !this.feneWarned) {
      this.feneWarned = true;
      this.warn('special-bonds', 'With bond_style fene, LAMMPS warns "Use special bonds = 0,1,1 with bond style fene": bonded neighbours should still feel the pair repulsion (special_bonds fene).',
        { url: page('bond_fene') });
    }
    return true;
  },

  /* Fix shake and rigid fixes must come before fixes that change the box (checked when a run starts). */
  fixOrder(where) {
    const st = this.st;
    let boxFix = null;
    for (const [id, f] of st.fixes) {
      if (f.broken) continue;
      const b = baseStyle(f.style);
      if (/^(npt|nph|press\/berendsen|deform|box\/relax|rigid\/npt|rigid\/nph|rigid\/npt\/small|rigid\/nph\/small|nvt\/sllod|npt\/sphere|nph\/sphere|npt\/asphere|nph\/asphere|press\/langevin|nphug|msst)$/.test(b)) {
        if (!boxFix) boxFix = { id, f };
        continue;
      }
      if (boxFix && /^(shake|rattle)$/.test(b)) {
        this.error('fix-order', 'Fix shake must come before any box changing fix',
          `fix ${id} (${b}, line ${f.line}) is defined after fix ${boxFix.id} (${boxFix.f.style}, line ${boxFix.f.line}), which changes the box; LAMMPS needs the constraints first, so it stops ${where}. Move the fix ${b} line above it.`,
          { url: page('fix_shake'), related: [f.line, boxFix.f.line] });
        return false;
      }
      if (boxFix && /^rigid/.test(b) && !/^rigid\/(npt|nph)/.test(b)) {
        this.error('fix-order', 'Rigid fixes must come before any box changing fix',
          `fix ${id} (${b}, line ${f.line}) is defined after fix ${boxFix.id} (${boxFix.f.style}, line ${boxFix.f.line}), which changes the box, so LAMMPS stops ${where}. Move the rigid fix above it.`,
          { url: page('fix_rigid'), related: [f.line, boxFix.f.line] });
        return false;
      }
    }
    return true;
  },

  /*
   * Pair::init: every i,i pair needs coefficients, and an i,j pair not given
   * is mixed from i,i and j,j, which some styles cannot do; with hybrid
   * styles, only when both types use the same single sub-style.
   */
  pairCoeffsComplete(where) {
    const st = this.st;
    const pair = st.pair;
    const n = st.ntypes;
    if (!n || st.fromRestart || st.uncertain || (st.pairCoeffsFromData !== false && st.boxHow !== 'create_box')) return true;
    if (/^(zero|none)$/.test(pair.style) && pair.args.includes('nocoeff')) return true;
    const hybrid = /^hybrid/.test(pair.style);
    const set = new Map();
    for (const c of st.pairCoeffs) {
      const is = this.typeList(c.i);
      const js = this.typeList(c.j);
      if (!is || !js) return true;
      for (const i of is) {
        for (const j of js) {
          const k = `${Math.min(i, j)},${Math.max(i, j)}`;
          if (!set.has(k)) set.set(k, new Set());
          set.get(k).add(c.style);
        }
      }
    }
    for (let t = 1; t <= n; t++) {
      if (!set.has(`${t},${t}`) || (hybrid && [...set.get(`${t},${t}`)].every(x => x === 'none'))) {
        if (hybrid && set.has(`${t},${t}`)) continue;
        const missingAll = st.pairCoeffs.length === 0;
        this.error('pair-coeff-missing', 'All pair coeffs are not set',
          missingAll ? `No pair_coeff line sets the coefficients of pair_style ${pair.style} (line ${pair.line}), so LAMMPS stops ${where}. Add pair_coeff lines (or "pair_coeff * * ..." for all types).`
            : `Atom type ${t} has no pair_coeff ${t} ${t} line (needed for pair_style ${pair.style}, and to mix ${t} with the other types), so LAMMPS stops ${where}.`,
          { url: page('pair_coeff'), related: [pair.line] });
        return false;
      }
    }
    for (let i = 1; i <= n; i++) {
      for (let j = i + 1; j <= n; j++) {
        if (set.has(`${i},${j}`)) continue;
        const si = set.get(`${i},${i}`);
        const sj = set.get(`${j},${j}`);
        let why = '';
        if (hybrid) {
          if (si.size !== 1 || sj.size !== 1 || [...si][0] !== [...sj][0]) why = `types ${i} and ${j} use different sub-styles (${[...si].join('+')} and ${[...sj].join('+')}), so LAMMPS cannot mix them`;
          else if ((PAIR_INFO[baseStyle([...si][0])] || {}).nomix) why = `sub-style ${[...si][0]} cannot mix coefficients`;
        } else if ((PAIR_INFO[baseStyle(pair.style)] || {}).nomix) why = `pair_style ${pair.style} cannot mix coefficients`;
        if (why) {
          this.error('pair-coeff-missing', 'All pair coeffs are not set',
            `There is no pair_coeff ${i} ${j} line, and ${why}, so every such pair needs its own line; LAMMPS stops ${where}.`,
            { url: page('pair_coeff'), related: [pair.line] });
          return false;
        }
      }
    }
    return true;
  },

  /* The types a type word covers, or null when that cannot be told. */
  typeList(word) {
    const n = this.st.ntypes;
    if (isUnknown(word) || !n) return null;
    const m = /^(\d*)(\*?)(\d*)$/.exec(word);
    if (!m) return null;
    const lo = m[1] ? Number(m[1]) : 1;
    const hi = m[2] ? (m[3] ? Number(m[3]) : n) : lo;
    const out = [];
    for (let t = lo; t <= Math.min(hi, n); t++) out.push(t);
    return out;
  },

  /* Thermo, dump and fix references that must exist when the run starts. */
  outputReferences(where) {
    const st = this.st;
    if (st.uncertain) return true;
    const ts = st.thermoStyle;
    if (ts && ts.refs) {
      for (const ref of ts.refs) {
        if (ref.kind === 'compute' && !st.computes.has(ref.name)) {
          this.error('undefined-compute', `Could not find thermo compute with ID ${ref.name}`,
            `thermo_style (line ${ts.line}) prints compute "${ref.name}", which no longer exists, so LAMMPS stops ${where}.`, { url: page('thermo_style'), related: [ts.line] });
          return false;
        }
        if (ref.kind === 'fix' && !st.fixes.has(ref.name)) {
          this.error('undefined-fix', `Could not find thermo fix ID ${ref.name}`,
            `thermo_style (line ${ts.line}) prints fix "${ref.name}", which no longer exists, so LAMMPS stops ${where}.`, { url: page('thermo_style'), related: [ts.line] });
          return false;
        }
        const fx = ref.kind === 'fix' ? st.fixes.get(ref.name) : null;
        const every = st.thermo.every;
        if (fx && fx.nfreq && every !== null && every !== undefined && every % fx.nfreq !== 0) {
          this.error('thermo-fix-freq', `Thermo and fix ${ref.name} not computed at compatible times`,
            `thermo prints every ${every} steps, but fix ${ref.name} has a new value only every ${fx.nfreq} steps (Nfreq), so LAMMPS stops ${where}. ` +
            'Make the thermo interval a multiple of Nfreq.', { url: page('thermo'), related: [ts.line, fx.line, st.thermo.line] });
          return false;
        }
        if (ref.kind === 'variable' && !this.vars.has(ref.name)) {
          this.error('undefined-variable', `Could not find thermo variable ${ref.name}`,
            `thermo_style (line ${ts.line}) prints variable "${ref.name}", which no longer exists, so LAMMPS stops ${where}.`, { url: page('thermo_style'), related: [ts.line] });
          return false;
        }
      }
    }
    return true;
  }
});


/* ---- advice at the start of a run ---- */

const THERMOSTAT_DAMP = { nvt: 'temp', npt: 'temp', 'temp/berendsen': 0, 'temp/csvr': 0, 'temp/csld': 0, 'rigid/nvt': 'temp', 'rigid/npt': 'temp', 'rigid/nvt/small': 'temp', 'rigid/npt/small': 'temp' };

Object.assign(Machine.prototype, {
  timeText(t) {
    const u = UNITS[this.st.units];
    if (!u || t === null || t === undefined) return '';
    return `${fmtNum(t)} ${u.time}`;
  },

  /* A time in the input's units, as a duration a person reads (2 ps, 1 ns). */
  duration(t) {
    const u = UNITS[this.st.units];
    if (!u || t === null || !Number.isFinite(t)) return '';
    if (!u.timeInPs) return `${fmtNum(t)} ${u.time}`;
    return formatPs(t * u.timeInPs);
  },

  runAdvice() {
    const st = this.st;
    const dt = this.timestep();
    const fixes = [...st.fixes.entries()].filter(([, f]) => !f.broken);
    const integrators = fixes.filter(([, f]) => f.integrates);
    if (!integrators.length && !st.uncertain) {
      this.warn('no-integrator', 'No fix moves the atoms (no fix nve, nvt, npt, rigid ...), so this run does not change positions. ' +
        'LAMMPS warns ("No fixes with time integration, atoms won\'t move"). Add an integrator, e.g. "fix 1 all nvt temp 300 300 $(100*dt)".', { url: page('fix_nve') });
    }
    // Two integrators on overlapping atoms.
    for (let a = 0; a < integrators.length; a++) {
      for (let b = a + 1; b < integrators.length; b++) {
        const [ia, fa] = integrators[a];
        const [ib, fb] = integrators[b];
        if (fa.group === fb.group || fa.group === 'all' || fb.group === 'all') {
          const key = `${ia}|${ib}`;
          if (this.doubleWarned && this.doubleWarned.has(key)) continue;
          (this.doubleWarned || (this.doubleWarned = new Set())).add(key);
          this.warn('double-integration', `fix ${ia} (${fa.style}, group ${fa.group}) and fix ${ib} (${fb.style}, group ${fb.group}) both move the same atoms, which then advance twice per step. ` +
            'LAMMPS warns ("One or more atoms are time integrated more than once"). Give each atom one integrator: use groups that do not overlap.',
          { url: page('fix_nve'), related: [fa.line, fb.line] });
        }
      }
    }
    // Constraints on rigid bodies.
    const shakes = fixes.filter(([, f]) => /^(shake|rattle)$/.test(baseStyle(f.style)));
    const rigids = fixes.filter(([, f]) => /^rigid/.test(baseStyle(f.style)));
    for (const [sid, s] of shakes) {
      for (const [rid, r] of rigids) {
        if (s.group === r.group || s.group === 'all' || r.group === 'all') {
          this.warn('shake-rigid', `fix ${sid} (${s.style}) and fix ${rid} (${r.style}) can act on the same atoms. LAMMPS does not check this, ` +
            'but a rigid body already keeps its bond lengths, and adding SHAKE constraints to it gives wrong dynamics. Leave the rigid bodies out of the SHAKE group.',
          { url: page('fix_shake'), related: [s.line, r.line] });
        }
      }
    }
    if (st.runs.length === 0 || !this.advisedTimestep) this.timestepAdvice(dt, shakes.length > 0 || rigids.length > 0);
    this.dataFileNotes();
    this.seedNotes();
    if (dt !== null) {
      for (const [id, f] of fixes) {
        const b = baseStyle(f.style);
        let tdamp = null;
        let pdamp = null;
        if (THERMOSTAT_DAMP[b] === 'temp' && f.kw && f.kw.get('temp')) tdamp = f.kw.get('temp')[2];
        else if (THERMOSTAT_DAMP[b] === 0 && f.pos && f.pos[2] !== undefined) tdamp = f.pos[2];
        if (/^(npt|nph|rigid\/npt|rigid\/nph|rigid\/npt\/small|rigid\/nph\/small)$/.test(b) && f.kw) {
          for (const k of ['iso', 'aniso', 'tri', 'x', 'y', 'z']) if (f.kw.get(k)) { pdamp = f.kw.get(k)[2]; break; }
        }
        if (b === 'press/berendsen' && f.kw) for (const k of ['iso', 'aniso', 'x', 'y', 'z']) if (f.kw.get(k)) { pdamp = f.kw.get(k)[2]; break; }
        this.dampAdvice(id, f, tdamp, 100, 'Tdamp', dt);
        this.dampAdvice(id, f, pdamp, 1000, 'Pdamp', dt);
      }
    }
    const steps = st.currentRunSteps;
    if (!st.thermo.line && !this.thermoNoted && !st.uncertain && steps !== 0) {
      this.thermoNoted = true;
      this.note('no-thermo', 'No thermo command: LAMMPS prints thermodynamic output only at the first and last step. Add e.g. "thermo 1000" to follow the run.', { url: page('thermo') });
    }
  },

  dampAdvice(id, f, value, ideal, name, dt) {
    if (value === null || value === undefined || isUnknown(value) || !isLammpsNumber(value) || !(dt > 0)) return;
    const steps = Number(value) / dt;
    const what = name === 'Tdamp' ? 'temperature' : 'pressure';
    const lowLimit = ideal / 10;
    const highLimit = ideal * 10;
    const url = page(f.style.startsWith('press/berendsen') ? 'fix_press_berendsen' : 'fix_nh');
    const said = `${name} ${value} ${UNITS[this.st.units] ? UNITS[this.st.units].time : ''} is ${fmtNum(steps)} timesteps`;
    if (steps < lowLimit) {
      this.warn('damping', `fix ${id}: ${said}. That couples the ${what} very tightly, so it can swing wildly or blow up; ` +
        `the LAMMPS manual suggests about ${ideal} timesteps (${name} = ${fmtNum(ideal * dt)}), i.e. $(${ideal}*dt).`, { url, line: f.line, file: f.file });
    } else if (steps > highLimit) {
      this.note('damping', `fix ${id}: ${said}. The ${what} will take a long time to reach its target; ` +
        `the LAMMPS manual suggests about ${ideal} timesteps (${name} = ${fmtNum(ideal * dt)}).`, { url, line: f.line, file: f.file });
    }
  },

  timestepAdvice(dt, constrained) {
    const st = this.st;
    this.advisedTimestep = true;
    const u = UNITS[st.units];
    if (!u) return;
    if (!st.timestep && !st.restartTimestep) {
      const human = u.timeInPs ? formatPs(u.timestep * u.timeInPs) : '';
      this.note('default-timestep', `No timestep command: LAMMPS uses the default for ${st.units} units, ${u.timestep} ${u.time}` +
        `${human && human !== `${u.timestep} ${u.time}` ? ` (${human})` : ''}. Set it with "timestep" to be sure of it.`, { url: page('timestep') });
    }
    if (dt === null) return;
    const pair = st.pair ? st.pair.style : '';
    const pairs = st.pair && st.pair.subs && st.pair.subs.length ? st.pair.subs.map(s => s.style) : [pair];
    const reax = pairs.some(p => /^reax/.test(p));
    const rel = st.timestep ? [st.timestep.line] : [];
    const fs = u.timeInPs ? dt * u.timeInPs * 1000 : null;
    if (fs === null) {
      if (st.units === 'lj' && dt > 0.01) this.note('timestep', `A timestep of ${dt} τ is large for Lennard-Jones units (the default is 0.005 τ); check that the energy is conserved.`, { url: page('timestep'), related: rel });
      return;
    }
    if (reax && fs > 0.5) {
      this.warn('timestep', `A timestep of ${fmtNum(fs)} fs is too large for ReaxFF, which models bonds breaking and forming with hydrogens; use 0.1 to 0.5 fs (0.25 fs is common).`, { url: page('pair_reaxff'), related: rel });
      return;
    }
    if (st.units === 'real' && !reax) {
      if (!constrained && fs > 1.0) {
        this.warn('timestep', `A timestep of ${fmtNum(fs)} fs without SHAKE or RATTLE is too large for an all-atom model: bonds to hydrogen vibrate in about 10 fs ` +
          'and need about 1 fs steps. Use timestep 1.0, or constrain those bonds with fix shake (then 2 fs works). Coarse-grained models are the exception.', { url: page('fix_shake'), related: rel });
      } else if (constrained && fs > 2.0) {
        this.warn('timestep', `A timestep of ${fmtNum(fs)} fs is large even with SHAKE: 2 fs is the usual limit for an all-atom model (coarse-grained models are the exception).`, { url: page('timestep'), related: rel });
      }
      return;
    }
    if (st.units === 'metal' && !reax) {
      if (fs >= 100) {
        this.warn('timestep', `timestep ${dt} in metal units is ${formatPs(dt)} per step, far too long for atoms (metal time is in picoseconds): use about 0.001 ps (1 fs).`, { url: page('units'), related: rel });
      } else if (fs > 5) {
        this.warn('timestep', `A timestep of ${fmtNum(fs)} fs (${dt} ps) is large for atoms; metals are usually run with 1 to 5 fs (0.001 to 0.005 ps).`, { url: page('timestep'), related: rel });
      }
    }
  },

  /* What only the data file can tell: say so once, instead of guessing. */
  dataFileNotes() {
    const st = this.st;
    if (this.dataNoted || st.boxHow !== 'read_data' || st.uncertain || this.dataInfo(st.dataFile)) return;
    this.dataNoted = true;
    const need = [];
    if (st.pair && !st.pair.broken && !st.pairCoeffs.length && !(PAIR_INFO[baseStyle(st.pair.style)] || {}).mb && !/^(zero|none)$/.test(st.pair.style)) need.push('the pair coefficients (Pair Coeffs or PairIJ Coeffs)');
    if (st.masses.has('*') && ![...st.masses].some(t => t !== '*')) need.push('the masses (Masses)');
    for (const k of ['bond', 'angle', 'dihedral', 'improper']) if (st.bonded[k] && st.bonded[k].style !== 'none' && !st.bondedCoeffLines?.[k]) need.push(`the ${k} coefficients`);
    if (!need.length) return;
    this.note('data-file', `This script does not set ${listWords(need)}, so they must come from ${st.dataFile}. ` +
      'STEMKit cannot see the data file: if a section is missing, LAMMPS stops when the run starts ("All pair coeffs are not set", "Not all per-type masses are set" ...).',
    { url: page('read_data'), line: st.boxLine, file: st.boxFile });
  },

  /* The same seed in two random-number streams gives correlated noise. */
  seedNotes() {
    const seeds = (this.st.seeds || []).filter(x => x.seed !== undefined && !isUnknown(x.seed));
    const seen = new Map();
    for (const x of seeds) {
      const prev = seen.get(x.seed);
      if (prev && prev.line !== x.line && !this.seedNoted) {
        this.seedNoted = true;
        this.note('seed', `${x.what} (line ${x.line}) uses the same random seed (${x.seed}) as ${prev.what} (line ${prev.line}); their random numbers are then correlated. Give each its own seed.`,
          { url: page('fix_langevin'), line: x.line });
      }
      seen.set(x.seed, x);
    }
  },

  minimizeAdvice() {
    const st = this.st;
    if (!st.pair && !st.uncertain && !st.fromRestart) this.warn('minimize-no-pair', 'There is no pair style, so the minimiser has only the bonded terms (if any) to work with.', { url: page('minimize') });
  },

  c_thermo_style(args) {
    const st = this.st;
    if (!args.length) { this.missing('thermo_style'); return; }
    if (!this.requireBox('thermo_style')) return;
    const style = args[0];
    if (st.thermoStyle && st.thermoStyle.modified) this.warn('thermo-modify-lost', 'A new thermo_style drops the earlier thermo_modify settings; LAMMPS warns ("New thermo_style command, previous thermo_modify settings will be lost"). Put thermo_modify after thermo_style.', { related: [st.thermoStyle.modifiedLine] });
    const ts = { style, line: this.entry.line, refs: [], keywords: [] };
    if (style === 'one' || style === 'multi' || style === 'yaml') {
      if (args.length > 1 && !isUnknown(args[1])) { /* LAMMPS ignores extra words here */ }
      st.thermoComputes = new Set(['temp', 'pe', 'press']);
      st.thermoStyle = ts;
      return;
    }
    if (style !== 'custom') {
      if (isUnknown(style)) return;
      this.error('bad-value', 'Illegal thermo style command', `"${style}" is not a thermo style; use one, multi, yaml or custom, so LAMMPS stops.`, { url: page('thermo_style') });
      return;
    }
    if (args.length === 1) { this.error('bad-args', 'Illegal thermo style custom command', 'thermo_style custom needs at least one keyword, so LAMMPS stops.'); return; }
    const used = new Set();
    for (const w of args.slice(1)) {
      if (isUnknown(w)) continue;
      ts.keywords.push(w);
      if (THERMO_WORDS.has(w)) { for (const c of THERMO_STYLE_COMPUTES[w] || []) used.add(c); continue; }
      const m = /^([cfv])_([^[\]]+)((\[[^\]]*\])*)$/.exec(w);
      if (!m || (m[3].match(/\[/g) || []).length > 2) {
        const near = didYouMeanIn(w, [...THERMO_WORDS]);
        this.error('thermo-keyword', `Unknown keyword '${w}' in thermo_style custom command`,
          `"${w}" is not a thermo keyword, so LAMMPS stops.${near ? ` Did you mean ${near}?` : ' Use the keywords of thermo_style custom, or c_ID, f_ID and v_name.'}`,
          { url: page('thermo_style') });
        return;
      }
      const kind = { c: 'compute', f: 'fix', v: 'variable' }[m[1]];
      const name = m[2];
      ts.refs.push({ kind, name, index: m[3] });
      if (st.uncertain || (st.fromRestart && kind !== 'variable')) continue;
      if (kind === 'compute' && !st.computes.has(name)) {
        const near = didYouMeanIn(name, [...st.computes.keys()]);
        this.error('undefined-compute', `Could not find thermo custom compute ID: ${name}`,
          `thermo_style prints c_${name}, but no compute "${name}" is defined at this point, so LAMMPS stops.${near ? ` Did you mean c_${near}?` : ' Define the compute before thermo_style.'}`,
          { url: page('thermo_style') });
        return;
      }
      if (kind === 'fix' && !st.fixes.has(name)) {
        this.error('undefined-fix', `Could not find thermo custom fix ID: ${name}`, `thermo_style prints f_${name}, but no fix "${name}" is defined at this point, so LAMMPS stops. Define the fix before thermo_style.`, { url: page('thermo_style') });
        return;
      }
      if (kind === 'variable') {
        const v = this.vars.get(name);
        if (!v) {
          this.error('undefined-variable', `Could not find thermo custom variable name: ${name}`, `thermo_style prints v_${name}, but no variable "${name}" is defined at this point, so LAMMPS stops. Define it before thermo_style.`, { url: page('thermo_style') });
          return;
        }
        if (!m[3] && !['equal', 'internal', 'python', 'timer'].includes(v.style)) {
          this.error('variable-style', 'Thermo custom variable is not equal-style variable', `thermo_style can print only equal-style variables (one number); "${name}" is ${v.style}-style, so LAMMPS stops.`, { url: page('thermo_style'), related: [v.line] });
          return;
        }
      }
      if (kind === 'compute') {
        const c = st.computes.get(name);
        const shape = COMPUTE_SHAPES[baseStyle(c.style)];
        const nidx = (m[3].match(/\[/g) || []).length;
        if (shape && !c.broken && !m[3].includes('*')) {
          const want = nidx === 0 ? 'scalar' : nidx === 1 ? 'vector' : 'array';
          if (!shape.includes(want) && !shape.includes('?')) {
            this.error('compute-shape', `Thermo compute does not compute ${want}`,
              `compute ${name} (${c.style}) gives ${shapeWords(shape)}, not a global ${want}, so c_${name}${m[3]} cannot be printed; LAMMPS stops. ` +
              (shape.includes('peratom') ? 'Reduce it to a number first, e.g. "compute sum all reduce sum c_' + name + '".' : ''),
            { url: page('thermo_style'), related: [c.line] });
            return;
          }
        }
      }
    }
    st.thermoComputes = used;
    st.thermoStyle = ts;
  },

  c_thermo_modify(args) {
    const r = this.checkSpec('thermo_modify', args);
    if (r === null) return;
    if (this.st.thermoStyle) { this.st.thermoStyle.modified = true; this.st.thermoStyle.modifiedLine = this.entry.line; }
    for (const k of ['temp', 'press']) {
      if (r.kw.has(k)) {
        const id = r.kw.get(k)[0];
        if (!this.st.computes.has(id) && !this.st.uncertain && !isUnknown(id)) {
          this.error('undefined-compute', k === 'temp' ? `Could not find thermo_modify temperature compute ${id}` : `Could not find thermo_modify pressure compute ${id}`,
            `thermo_modify ${k} names compute "${id}", which is not defined, so LAMMPS stops.`, { url: page('thermo_modify') });
          return;
        }
        this.st.thermoComputes.add(k);
      }
    }
  }
});

/* What a compute gives: scalar, vector, array, peratom, local. */
const COMPUTE_SHAPES = {
  'ackland/atom': ['peratom'],
  'aggregate/atom': ['peratom'],
  'angle': ['vector','?'],
  'angle/local': ['local','?'],
  'angmom/chunk': ['array'],
  'bond': ['vector','?'],
  'bond/local': ['local','?'],
  'centro/atom': ['peratom','?'],
  'centroid/stress/atom': ['peratom'],
  'chunk/atom': ['scalar','peratom'],
  'cluster/atom': ['peratom'],
  'cna/atom': ['peratom'],
  'cnp/atom': ['peratom'],
  'com': ['vector'],
  'com/chunk': ['array'],
  'coord/atom': ['peratom','?'],
  'count/type': ['scalar','vector','?'],
  'dihedral': ['vector','?'],
  'dihedral/local': ['local','?'],
  'dipole': ['scalar','vector'],
  'dipole/chunk': ['array'],
  'displace/atom': ['peratom'],
  'entropy/atom': ['peratom'],
  'erotate/rigid': ['scalar'],
  'erotate/sphere': ['scalar'],
  'erotate/sphere/atom': ['peratom'],
  'fragment/atom': ['peratom'],
  'global/atom': ['peratom','?'],
  'group/group': ['scalar','vector'],
  'gyration': ['scalar','vector'],
  'gyration/chunk': ['vector','array','?'],
  'heat/flux': ['vector'],
  'hexorder/atom': ['peratom'],
  'improper': ['vector','?'],
  'improper/local': ['local','?'],
  'inertia/chunk': ['array'],
  'ke': ['scalar'],
  'ke/atom': ['peratom'],
  'ke/rigid': ['scalar'],
  'momentum': ['vector'],
  'msd': ['vector'],
  'msd/chunk': ['array'],
  'omega/chunk': ['array'],
  'orientorder/atom': ['peratom','?'],
  'pair': ['scalar','vector','?'],
  'pair/local': ['local','?'],
  'pe': ['scalar'],
  'pe/atom': ['peratom'],
  'pressure': ['scalar','vector'],
  'property/atom': ['peratom','?'],
  'property/chunk': ['vector','array','?'],
  'property/local': ['local','?'],
  'rdf': ['array'],
  'reduce': ['scalar','vector','?'],
  'reduce/chunk': ['vector','array','?'],
  'reduce/region': ['scalar','vector','?'],
  'slice': ['vector','array','?'],
  'stress/atom': ['peratom'],
  'stress/cartesian': ['array'],
  'temp': ['scalar','vector'],
  'temp/chunk': ['scalar','vector','array','?'],
  'temp/com': ['scalar','vector'],
  'temp/deform': ['scalar','vector'],
  'temp/partial': ['scalar','vector'],
  'temp/profile': ['scalar','vector','array','?'],
  'temp/ramp': ['scalar','vector'],
  'temp/region': ['scalar','vector'],
  'temp/sphere': ['scalar','vector'],
  'torque/chunk': ['array'],
  'vacf': ['vector'],
  'vcm/chunk': ['array']
};
function shapeWords(shape) {
  const w = { scalar: 'one number', vector: 'a vector', array: 'an array', peratom: 'one value per atom', local: 'local values (per bond, pair...)' };
  return shape.map(s => w[s] || s).join(' and ');
}

/* A time in ps as a person reads it: 2 fs, 10 ps, 1 ns, 1.5 µs. */
export function formatPs(ps) {
  const a = Math.abs(ps);
  if (a === 0) return '0 ps';
  if (a < 1e-3) return `${fmtNum(ps * 1e6)} as`;
  if (a < 1) return `${fmtNum(ps * 1000)} fs`;
  if (a < 1000) return `${fmtNum(ps)} ps`;
  if (a < 1e6) return `${fmtNum(ps / 1000)} ns`;
  if (a < 1e9) return `${fmtNum(ps / 1e6)} µs`;
  return `${fmtNum(ps / 1e9)} ms`;
}

/* ---- the end of the script ---- */

Object.assign(Machine.prototype, {
  finish() {
    const st = this.st;
    const last = this.parsed.lines.filter(l => l.kind === 'command').pop();
    this.entry = last || { line: 1, lastLine: 1 };
    if (this.quitLine === undefined && !st.runs.length && st.box && !st.uncertain && this.parsed.lines.some(l => l.kind === 'command')) {
      this.note('no-run', 'The script sets a system up but never runs it (no run or minimize): LAMMPS will stop after reading it.', { url: page('run') });
    }
    if (this.needed && this.needed.size && !this.packages) {
      const list = [...this.needed.keys()].sort();
      this.note('packages', `This script needs LAMMPS built with the ${list.join(', ')} package${list.length > 1 ? 's' : ''} ("lmp -h" lists the packages of a build).`,
        { url: page('Packages_details'), line: this.parsed.lines.find(l => l.kind === 'command')?.line || 1 });
    }
  }
});

/**
 * Check an input script the way LAMMPS runs it, top to bottom, following
 * `include` (for files given in `files`), `jump`/`label` loops, `next` and
 * `if` (when the condition can be decided from the script and `vars`).
 *
 * LAMMPS stops at its first error; the checker reports it and carries on,
 * so later problems show too (the first error is the one LAMMPS reports).
 * What only the data file or the run can tell (missing coefficients in a
 * data file, lost atoms, bond atoms missing) is not guessed: such checks are
 * skipped, and say so as notes where it matters.
 *
 * @param {string|ReturnType<typeof parseInput>} input
 * @param {object} [options]
 * @param {string[]|null} [options.packages] - The packages of the LAMMPS build
 *   (as `lmp -h` lists them); with them, styles from other packages are
 *   errors, as that LAMMPS reports them. Without, every package is assumed.
 * @param {Object<string,string|string[]>} [options.vars] - Index variables
 *   given on the command line (`-var name value ...`).
 * @param {Object<string,string>} [options.files] - Other input files by name,
 *   for `include` and `jump file`. Issues from them carry `file`.
 * @param {Object<string,object>} [options.data] - What is known about data
 *   files by name: `{types:{atom:N}, massesSet:true, pairCoeffs:true}`.
 * @param {object} [options.restart] - What to assume a read_restart brings back, when
 *   the file is not known: `{units, atomStyle, types, pairStyle, timestep}`.
 *   {@link checkChain} passes the state the earlier stages saved instead.
 * @param {number} [options.maxCommands=100000] - Stop following the script after this many
 *   commands (a jump loop is followed 500 times, then left as if it had ended).
 * @returns {{issues:LammpsIssue[], firstError:LammpsIssue|null, state:object, parsed:ReturnType<typeof parseInput>,
 *   trace:Array<{file:string, line:number, text:string}>, firstErrorAt:number}}
 *   `firstError` is the error LAMMPS stops on (the first in the order the
 *   script runs, which in a loop need not be the lowest line number);
 *   `trace` lists the commands in the order they ran, and `firstErrorAt`
 *   is the position of the first error in it.
 *   `state`: {units, atomStyle, dimension, boundary, box, timestep:{value, line, isDefault},
 *   groups, fixes, computes, variables, regions, dumps, runs:[{line, steps, kind}], packages}.
 */
export function checkInput(input, options = {}) {
  const parsed = typeof input === 'string' || input == null ? parseInput(input) : input;
  const m = new Machine(parsed, options);
  m.options = options;
  m.run();
  m.finish();
  const order = (i) => (i.file ? 1 : 0);
  const issues = m.issues.slice().sort((a, b) => order(a) - order(b) || (a.file || '').localeCompare(b.file || '') || a.line - b.line);
  const result = { issues, firstError: m.firstError || null, state: stateSummary(m), parsed, trace: m.traceList || [], firstErrorAt: m.firstErrorAt ?? -1 };
  Object.defineProperty(result, 'contexts', { value: m.contexts || new Map(), enumerable: false });
  Object.defineProperty(result, 'includedFiles', { value: m.parsedFiles || new Map(), enumerable: false });
  // What write_restart and restart saved, for checkChain (not enumerable: internal).
  Object.defineProperty(result, 'savedRestarts', { value: m.savedRestarts || new Map(), enumerable: false });
  return result;
}

function stateSummary(m) {
  const st = m.st;
  const u = UNITS[st.units];
  const dt = m.timestep();
  const list = (map, f) => [...map.entries()].map(([id, x]) => ({ id, ...f(x) }));
  return {
    units: st.units,
    atomStyle: st.atomStyle,
    dimension: st.dimension,
    boundary: st.boundary.slice(),
    box: st.box ? { how: st.boxHow, line: st.boxLine, types: st.ntypes } : null,
    timestep: { value: dt, line: st.timestep ? st.timestep.line : null, isDefault: !st.timestep, unit: u ? u.time : '' },
    pair: st.pair ? { style: st.pair.style, line: st.pair.line } : null,
    kspace: st.kspace ? { style: st.kspace.style, line: st.kspace.line } : null,
    groups: [...st.groups.keys()],
    fixes: list(st.fixes, f => ({ style: f.style, group: f.group, line: f.line, file: f.file })),
    computes: list(st.computes, c => ({ style: c.style, group: c.group, line: c.line })).filter(c => c.line),
    dumps: list(st.dumps, d => ({ style: d.style, group: d.group, every: d.every, file: d.file, line: d.line })),
    variables: list(m.vars, v => ({ style: v.style, line: v.line })),
    regions: list(st.regions, r => ({ style: r.style, line: r.line })),
    runs: st.runs.map(r => ({ ...r, time: r.kind === 'run' && r.steps !== null && dt !== null ? r.steps * dt : null })),
    packages: m.needed ? [...m.needed.keys()].sort() : []
  };
}

/*
 * Whether `read_restart name` reads a file written as `pattern`: a "*" in
 * either stands for the timestep LAMMPS puts there.
 */
function restartNameMatch(pattern, name) {
  if (pattern === name) return true;
  const rx = (s) => new RegExp(`^${s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\d+')}$`);
  return (name.includes('*') && rx(name).test(pattern.replace(/\*/g, '0'))) || (pattern.includes('*') && rx(pattern).test(name)) ||
    (name.includes('*') && pattern.includes('*') && name.replace(/\*/g, '') === pattern.replace(/\*/g, ''));
}

/**
 * Check the inputs of a workflow in the order they run, carrying what each
 * `write_restart file` or `restart N file` saves into the stage that reads
 * it with `read_restart` (a `*` in a name matches the timestep LAMMPS puts
 * there). Stages read with `read_data` start fresh.
 *
 * @param {Array<{name:string, text:string}>} stages
 * @param {object} [options] - As for {@link checkInput}; `files` and `vars` apply to every stage.
 * @returns {Array<{name:string} & ReturnType<typeof checkInput>>}
 */
export function checkChain(stages, options = {}) {
  const restartStates = new Map(options.restartStates || []);
  const out = [];
  for (const stage of stages) {
    const r = checkInput(stage.text, { ...options, restartStates });
    for (const [k, v] of r.savedRestarts || []) restartStates.set(k, { ...v, from: `${v.from} in ${stage.name}` });
    out.push({ name: stage.name, ...r });
  }
  return out;
}

/* ---- a few more commands with state ---- */

Object.assign(Machine.prototype, {
  /*
   * reset_atoms (id, mol), delete_bonds, create_bonds many, balance and
   * write_coeff set the system up as a run does before they work, so the
   * same checks apply (masses, pair coefficients ...).
   */
  c_reset_atoms(args) {
    if (!args.length) return;
    if (!this.requireBox('reset_atoms')) return;
    const sub = SPECS[`reset_atoms ${args[0]}`] ? `reset_atoms ${args[0]}` : null;
    if (sub && this.checkSpec(sub, args) === null) return;
    if (args[0] === 'id' || args[0] === 'mol') this.initChecks('reset_atoms');
  },

  c_delete_bonds(args) {
    if (!this.requireBox('delete_bonds')) return;
    if (this.checkSpec('delete_bonds', args) === null) return;
    this.initChecks('delete_bonds');
  },

  c_write_coeff(args) {
    if (!this.requireBox('write_coeff')) return;
    this.initChecks('write_coeff');
  },

  c_set(args) {
    if (!this.requireBox('set')) return;
    const sub = [0, 1].map(k => `set ${args[k]}`).find(k => SPECS[k]);
    if (this.checkSpec(sub || 'set', args) === null) return;
    if (args.includes('charge')) this.st.charges = true;
  },

  c_molecule(args) {
    if (args.length < 2) { this.missing('molecule'); return; }
    if (this.st.molecules.has(args[0]) && !isUnknown(args[0])) {
      this.error('molecule-reuse', `Reuse of molecule template ID ${args[0]}`, `Molecule template "${args[0]}" already exists, so LAMMPS stops. Use another ID.`);
      return;
    }
    this.st.molecules.set(args[0], { line: this.entry.line, file: args[1] });
  },

  /* read_dump and rerun: the reader style of `format` comes from a package. */
  readerFormat(args) {
    const i = args.indexOf('format');
    if (i < 0 || args[i + 1] === undefined) return true;
    const f = args[i + 1];
    if (f === 'native' || isUnknown(f)) return true;
    return this.checkStyle('reader', f, 'reader');
  },

  c_read_dump(args) {
    if (!this.requireBox('read_dump')) return;
    this.readerFormat(args);
  },

  c_rerun(args) {
    if (!this.requireBox('rerun')) return;
    if (!this.readerFormat(args)) return;
    this.startRun('rerun', null);
  }
});

/* ------------------------------------------------------------------ *
 * Explaining
 * ------------------------------------------------------------------ */

/* The words, units and timestep that were in force on a line, and helpers to say values in them. */
function lineContext(ctx) {
  const u = UNITS[ctx.units] || null;
  const dt = ctx.dt;
  const num = (w) => (isLammpsNumber(w) ? Number(w) : null);
  const q = (w, kind) => {
    if (w === undefined) return '?';
    if (isUnknown(w)) return 'a value set when the script runs';
    if (/^v_/.test(w)) return `variable ${w.slice(2)}`;
    return u && u[kind] ? `${w} ${u[kind]}` : `${w}`;
  };
  const time = (w) => {
    const x = num(w);
    if (x === null) return q(w, 'time');
    if (!u) return `${w} (time units)`;
    if (!u.timeInPs) return `${w} ${u.time}`;
    const human = formatPs(x * u.timeInPs);
    return `${w} ${u.time}${human.replace(/\s/, ' ') !== `${fmtNum(x)} ${u.time}` ? ` (${human})` : ''}`;
  };
  const steps = (w) => {
    const n = num(w);
    if (n === null || dt === null || dt === undefined) return null;
    return n * dt;
  };
  const span = (n) => {
    const t = steps(n);
    if (t === null) return '';
    return u && u.timeInPs ? formatPs(t * u.timeInPs) : `${fmtNum(t)} ${u ? u.time : 'time units'}`;
  };
  const damp = (w, ideal) => {
    const x = num(w);
    if (x === null || !dt) return time(w);
    const n = x / dt;
    return `${time(w)} = ${fmtNum(n)} steps (the LAMMPS manual suggests about ${ideal})`;
  };
  return { ...ctx, u, num, q, time, steps, span, damp };
}

const plural = (n, s) => `${n} ${n === '1' || n === 1 ? s : `${s}s`}`;
const listWords = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const BOUNDARY_WORDS = { p: 'periodic', f: 'fixed (atoms that leave are lost)', s: 'shrink-wrapped to the atoms', m: 'shrink-wrapped, but never smaller than the initial size' };
const THERMO_COLUMN_WORDS = {
  step: 'timestep', elapsed: 'steps since the run started', time: 'simulation time', dt: 'timestep size', cpu: 'CPU time', tpcpu: 'time per CPU second',
  spcpu: 'steps per CPU second', cpuremain: 'estimated CPU time left', atoms: 'number of atoms', temp: 'temperature', press: 'pressure',
  pe: 'potential energy', ke: 'kinetic energy', etotal: 'total energy', enthalpy: 'enthalpy', evdwl: 'van der Waals energy',
  ecoul: 'short-range Coulomb energy', epair: 'pair energy', ebond: 'bond energy', eangle: 'angle energy', edihed: 'dihedral energy',
  eimp: 'improper energy', emol: 'bonded energy', elong: 'long-range (kspace) energy', etail: 'van der Waals tail correction',
  vol: 'volume', density: 'density', lx: 'box length x', ly: 'box length y', lz: 'box length z', pxx: 'pressure xx', pyy: 'pressure yy',
  pzz: 'pressure zz', pxy: 'pressure xy', pxz: 'pressure xz', pyz: 'pressure yz', fmax: 'largest force', fnorm: 'length of the force vector',
  ecouple: 'energy exchanged with thermostats and barostats', econserve: 'total energy plus ecouple (should stay constant)'
};
const DUMP_COLUMN_WORDS = {
  id: 'atom ID', mol: 'molecule ID', type: 'atom type', element: 'element', mass: 'mass', x: 'x', y: 'y', z: 'z', xs: 'scaled x', ys: 'scaled y', zs: 'scaled z',
  xu: 'unwrapped x', yu: 'unwrapped y', zu: 'unwrapped z', ix: 'image flag x', iy: 'image flag y', iz: 'image flag z', vx: 'velocity x', vy: 'velocity y', vz: 'velocity z',
  fx: 'force x', fy: 'force y', fz: 'force z', q: 'charge', radius: 'radius', diameter: 'diameter'
};

/* Meanings of the commands people use most: (ctx) -> text. */
const MEANINGS = {
  units(c) {
    const u = UNITS[c.args[0]];
    if (!u) return '';
    if (c.args[0] === 'lj') return 'Reduced Lennard-Jones units: distances in σ, energies in ε, masses in m, time in τ; the default timestep is 0.005 τ.';
    const human = u.timeInPs ? formatPs(u.timestep * u.timeInPs) : '';
    return `${u.label}: distances in ${u.distance}, time in ${u.time}, energy in ${u.energy}, mass in ${u.mass}, temperature in ${u.temperature}, pressure in ${u.pressure}, charge in ${u.charge}. ` +
      `The default timestep is ${u.timestep} ${u.time}${human && human !== `${u.timestep} ${u.time}` ? ` (${human})` : ''}.`;
  },
  atom_style(c) {
    const p = ATOM_STYLES[c.args[0]];
    if (c.args[0] === 'hybrid') return `Combines the atom styles ${listWords(c.args.slice(1).filter(a => commandInfo('atom_style', a)))}: every atom has the properties of all of them.`;
    if (!p) return '';
    const has = [];
    if (p.mol) has.push('a molecule ID');
    if (p.q) has.push('a charge');
    if (p.radius) has.push('a radius (and its own mass)');
    const topo = ['bonds', 'angles', 'dihedrals', 'impropers'].filter(k => p[k]);
    return `Each atom has a type and a position${has.length ? `, ${listWords(has)}` : ''}.` +
      (topo.length ? ` The topology can hold ${listWords(topo)}.` : ' No bonds.') + (p.q ? '' : ' No charges, so no Coulomb interactions.');
  },
  dimension(c) { return `${c.args[0]}d simulation.`; },
  boundary(c) {
    const dims = ['x', 'y', 'z'];
    const words = c.args.map((b, i) => (b.length === 2 ? `${dims[i]}: ${BOUNDARY_WORDS[b[0]] || b[0]} below, ${BOUNDARY_WORDS[b[1]] || b[1]} above` : `${dims[i]}: ${BOUNDARY_WORDS[b] || b}`));
    if (c.args.every(b => b === 'p')) return 'Periodic in x, y and z: the box repeats in every direction.';
    return `${words.join('; ')}.`;
  },
  read_data(c) { return `Reads the box, the atoms (and any bonds, angles, coefficients and masses it holds) from ${c.args[0]}.`; },
  read_restart(c) { return `Restarts from ${c.args[0]}: the units, atom style, box, atoms, groups, masses, force field and special_bonds come from it; fixes, computes, kspace and output must be given again.`; },
  write_restart(c) { return `Writes the current state to the binary restart file ${c.args[0]}.`; },
  write_data(c) { return `Writes the box, atoms and topology${c.args.includes('nocoeff') ? '' : ' (and coefficients)'} to the data file ${c.args[0]}.`; },
  restart(c) {
    if (c.args[0] === '0') return 'No more restart files are written.';
    const files = c.args.slice(1).filter(a => !/^(fileper|nfile)$/.test(a) && !/^\d+$/.test(a));
    return `Writes a restart file every ${plural(c.args[0], 'step')}${c.span(c.args[0]) ? ` (${c.span(c.args[0])})` : ''} to ${files.length === 2 ? `${files[0]} and ${files[1]} in turn` : files[0]}${files[0] && files[0].includes('*') ? ' (* becomes the step number)' : ''}.`;
  },
  lattice(c) {
    const [style, scale] = c.args;
    if (style === 'none') return `No lattice; the scale ${scale} is the length used where lattice units are asked for.`;
    const an = /^(fcc|hcp|sc|sq|sq2)$/.test(style) ? 'An' : 'A';
    if (c.units === 'lj') return `${an} ${style} lattice whose spacing gives a reduced density of ${scale} (atoms per σ³).`;
    return `${an} ${style} lattice with lattice constant ${c.q(scale, 'distance')}.`;
  },
  region(c) {
    const [id, style, ...a] = c.args;
    const unitsBox = c.args.includes('units') && c.args[c.args.indexOf('units') + 1] === 'box';
    const lu = unitsBox ? (c.u ? c.u.distance : '') : 'lattice spacings';
    const side = c.args.includes('side') && c.args[c.args.indexOf('side') + 1] === 'out' ? ' (everything outside it)' : '';
    if (style === 'block') return `Region ${id}: a box from x = ${a[0]} to ${a[1]}, y = ${a[2]} to ${a[3]}, z = ${a[4]} to ${a[5]}${side}, in ${lu}${unitsBox ? '' : ' (add "units box" to give distances)'}. INF and EDGE mean the box bounds.`;
    if (style === 'sphere') return `Region ${id}: a sphere centred at (${a[0]}, ${a[1]}, ${a[2]}) with radius ${a[3]}${side}, in ${lu}.`;
    if (style === 'cylinder') return `Region ${id}: a cylinder along ${a[0]}, centred at (${a[1]}, ${a[2]}), radius ${a[3]}, from ${a[4]} to ${a[5]}${side}, in ${lu}.`;
    if (style === 'prism') return `Region ${id}: a tilted box (for a triclinic simulation box)${side}, in ${lu}.`;
    if (style === 'plane') return `Region ${id}: everything on one side of the plane through (${a[0]}, ${a[1]}, ${a[2]}) with normal (${a[3]}, ${a[4]}, ${a[5]}).`;
    if (style === 'union' || style === 'intersect') return `Region ${id}: the ${style === 'union' ? 'union' : 'intersection'} of regions ${listWords(a.slice(1, 1 + Number(a[0])))}.`;
    return '';
  },
  create_box(c) { return `Creates the simulation box from region ${c.args[1]}, with ${plural(c.args[0], 'atom type')}${c.args.length > 2 ? ' and room for the bonded types given' : ''}. No atoms yet.`; },
  create_atoms(c) {
    const [type, style] = c.args;
    if (style === 'box') return `Fills the whole box with atoms of type ${type} on the lattice.`;
    if (style === 'region') return `Fills region ${c.args[2]} with atoms of type ${type} on the lattice.`;
    if (style === 'single') return `Adds one atom of type ${type} at (${c.args.slice(2, 5).join(', ')}).`;
    if (style === 'random') return `Adds ${c.args[2]} atoms of type ${type} at random positions (seed ${c.args[3]})${c.args[4] && c.args[4] !== 'NULL' ? ` in region ${c.args[4]}` : ''}.`;
    return '';
  },
  mass(c) { return `Atom type${/\*/.test(c.args[0]) ? 's' : ''} ${c.args[0]}: mass ${c.q(c.args[1], 'mass')}.`; },
  velocity(c) {
    const [g, style, ...a] = c.args;
    const kw = kwMap(c.args, { create: 4, set: 5, scale: 3, ramp: 8, zero: 3 }[style] || 2);
    if (style === 'create') {
      const extra = [];
      if (kw.dist) extra.push(kw.dist === 'gaussian' ? 'Gaussian (Maxwell-Boltzmann) distribution' : 'uniform distribution');
      if (kw.mom && /yes|1|on|true/.test(kw.mom)) extra.push('no net momentum');
      if (kw.rot && /yes|1|on|true/.test(kw.rot)) extra.push('no net rotation');
      if (kw.loop) extra.push(`loop ${kw.loop}${kw.loop === 'geom' ? ' (the same velocities on any number of processors)' : ''}`);
      return `Gives group ${g} random velocities for a temperature of ${c.q(a[0], 'temperature')} (seed ${a[1]})${extra.length ? `: ${extra.join(', ')}` : ''}.`;
    }
    if (style === 'set') return `Sets the velocity of group ${g} to (${a.slice(0, 3).join(', ')}) ${c.u ? c.u.velocity : ''}; NULL leaves a component as it is.`;
    if (style === 'scale') return `Rescales the velocities of group ${g} to a temperature of ${c.q(a[0], 'temperature')}.`;
    if (style === 'zero') return `Removes the ${a[0] === 'angular' ? 'angular' : 'linear'} momentum of group ${g}.`;
    if (style === 'ramp') return `Gives group ${g} a velocity ${a[0]} that rises from ${a[1]} to ${a[2]} along ${a[3]}.`;
    return '';
  },
  timestep(c) {
    const v = c.args[0];
    if (!c.u || !isLammpsNumber(v)) return `Each step is ${v} time units.`;
    if (!c.u.timeInPs) return `Each step is ${v} τ (reduced time; the default is 0.005 τ).`;
    const human = formatPs(Number(v) * c.u.timeInPs);
    return `Each step is ${v} ${c.u.time}${human !== `${fmtNum(Number(v))} ${c.u.time}` ? ` = ${human}` : ''} (${c.units} units).`;
  },
  run(c) {
    const n = c.args[0];
    if (n === '0') return 'Sets the system up and computes forces and energies once, without moving the atoms (useful to check an input or print starting values).';
    const t = c.span(n);
    return `Runs ${Number(n).toLocaleString('en-GB')} steps${t ? ` = ${t}` : ''}${c.args.includes('upto') ? ' (up to that step number, counting earlier runs)' : ''}.`;
  },
  minimize(c) {
    const [etol, ftol, maxiter, maxeval] = c.args;
    return `Minimises the energy until the energy changes by less than ${etol} (relative) between iterations, or the forces fall below ${c.q(ftol, 'force')}, ` +
      `or after ${maxiter} iterations or ${maxeval} force evaluations, whichever comes first.`;
  },
  min_style(c) { return { cg: 'Conjugate gradient (the default minimiser).', sd: 'Steepest descent: robust but slow.', fire: 'FIRE: damped dynamics, good for rough starting structures.', hftn: 'Hessian-free truncated Newton.', quickmin: 'Damped dynamics (quick minimisation).' }[c.args[0]] || ''; },
  thermo(c) {
    if (/^v_/.test(c.args[0])) return `Prints thermodynamic output at the steps given by variable ${c.args[0].slice(2)}.`;
    if (c.args[0] === '0') return 'Prints thermodynamic output only at the first and last step of each run.';
    const t = c.span(c.args[0]);
    return `Prints thermodynamic output every ${plural(c.args[0], 'step')}${t ? ` (every ${t})` : ''}.`;
  },
  thermo_style(c) {
    if (c.args[0] !== 'custom') return { one: 'Prints step, temperature, pair energy, bonded energy, total energy and pressure.', multi: 'Prints several lines per output with the energy terms.', yaml: 'Prints thermodynamic output in YAML.' }[c.args[0]] || '';
    return `Prints these columns: ${c.args.slice(1).map(w => THERMO_COLUMN_WORDS[w] || (/^c_/.test(w) ? `compute ${w.slice(2)}` : /^f_/.test(w) ? `fix ${w.slice(2)}` : /^v_/.test(w) ? `variable ${w.slice(2)}` : w)).join(', ')}.`;
  },
  neighbor(c) {
    return `Neighbour lists hold every pair within the force cut-off plus a skin of ${c.q(c.args[0], 'distance')}, so they need rebuilding only when an atom has moved half the skin; "${c.args[1]}" is how they are built${c.args[1] === 'bin' ? ' (spatial bins, the usual choice)' : ''}.`;
  },
  neigh_modify(c) {
    const k = kwMap(c.args, 0);
    const parts = [];
    if (k.every || k.delay) parts.push(`lists are considered every ${k.every || 1} step(s), not before ${k.delay ?? 0} steps after the last build`);
    if (k.check) parts.push(/yes|1|on|true/.test(k.check) ? 'and rebuilt only when an atom has moved more than half the skin' : 'and rebuilt every time without checking');
    if (k.one) parts.push(`at most ${k.one} neighbours per atom`);
    if (k.page) parts.push(`${k.page} neighbours per memory page`);
    if (k.exclude) parts.push(`some pairs are excluded (${k.exclude})`);
    return parts.length ? `Neighbour lists: ${parts.join(', ')}.` : '';
  },
  special_bonds(c) {
    const words = { charmm: 'CHARMM: 1-2, 1-3 and 1-4 pairs excluded from LJ and Coulomb (the dihedral style weights 1-4)', amber: 'AMBER: 1-2 and 1-3 excluded, 1-4 LJ × 0.5 and Coulomb × 5/6',
      dreiding: 'DREIDING: 1-2 and 1-3 excluded, 1-4 at full strength', fene: 'FENE: only directly bonded pairs excluded' };
    const named = c.args.find(a => words[a]);
    if (named) return `${words[named]}.`;
    const k = kwMap(c.args, 0);
    const lj = k['lj/coul'] || k.lj;
    const coul = k['lj/coul'] || k.coul;
    const parts = [];
    if (lj) parts.push(`LJ between atoms 1, 2 and 3 bonds apart is scaled by ${c.args.slice(c.args.indexOf(k['lj/coul'] ? 'lj/coul' : 'lj') + 1, c.args.indexOf(k['lj/coul'] ? 'lj/coul' : 'lj') + 4).join(', ')}`);
    if (coul && !k['lj/coul']) parts.push(`Coulomb by ${c.args.slice(c.args.indexOf('coul') + 1, c.args.indexOf('coul') + 4).join(', ')}`);
    return parts.length ? `${parts.join('; ')} (0 excludes the pair, 1 keeps it whole).` : '';
  },
  kspace_style(c) {
    const s = c.args[0];
    const names = { pppm: 'PPPM (particle-particle particle-mesh)', ewald: 'Ewald summation', msm: 'MSM (multilevel summation)', 'pppm/tip4p': 'PPPM for TIP4P water', 'pppm/disp': 'PPPM for Coulomb and dispersion', 'ewald/disp': 'Ewald for Coulomb and dispersion', 'pppm/cg': 'PPPM for systems with few charged atoms' };
    const name = names[baseStyle(s)] || s;
    if (s === 'none') return 'No long-range solver.';
    return `Long-range ${/disp/.test(s) ? 'Coulomb and dispersion' : 'Coulomb'} by ${name}, to a relative accuracy of ${c.args[1]} in the forces${baseStyle(s).startsWith('pppm') ? ' (LAMMPS picks the mesh to reach it)' : ''}.`;
  },
  kspace_modify(c) {
    const k = kwMap(c.args, 0);
    const parts = [];
    if (k.slab) parts.push(`slab correction for a system periodic in x and y only (empty space ${k.slab} × the box height)`);
    if (k.mesh) parts.push(`mesh set to ${c.args.slice(c.args.indexOf('mesh') + 1, c.args.indexOf('mesh') + 4).join(' × ')}`);
    if (k.order) parts.push(`interpolation order ${k.order}`);
    if (k.gewald) parts.push(`Ewald splitting parameter ${k.gewald}`);
    return parts.length ? `${parts.join('; ')}.` : '';
  },
  pair_modify(c) {
    const k = kwMap(c.args, 0);
    const parts = [];
    if (k.mix) parts.push(`unlike pairs (i ≠ j) without their own pair_coeff get ${k.mix} averages of the like-pair values`);
    if (k.shift) parts.push(/yes|1|on|true/.test(k.shift) ? 'the energy is shifted to zero at the cut-off' : 'no energy shift');
    if (k.tail) parts.push(/yes|1|on|true/.test(k.tail) ? 'a tail correction adds the energy and pressure of the LJ interactions beyond the cut-off' : 'no tail correction');
    return parts.length ? `${parts.join('; ')}.` : '';
  },
  group(c) {
    const [g, style, ...a] = c.args;
    if (style === 'type') return `Group ${g}: atoms of type${a.length > 1 || /[*:]/.test(a[0] || '') ? 's' : ''} ${a.join(' ')}.`;
    if (style === 'molecule') return `Group ${g}: atoms of molecule${a.length > 1 ? 's' : ''} ${a.join(' ')}.`;
    if (style === 'id') return `Group ${g}: atoms with ID ${a.join(' ')}.`;
    if (style === 'region') return `Group ${g}: atoms inside region ${a[0]} now (the group does not follow them later).`;
    if (style === 'union') return `Group ${g}: atoms in any of ${listWords(a)}.`;
    if (style === 'subtract') return `Group ${g}: atoms of ${a[0]} that are not in ${listWords(a.slice(1))}.`;
    if (style === 'intersect') return `Group ${g}: atoms in all of ${listWords(a)}.`;
    if (style === 'delete') return `Deletes group ${g}.`;
    if (style === 'dynamic') return `Group ${g}: re-evaluated every few steps from group ${a[0]}${a.includes('region') ? ` and region ${a[a.indexOf('region') + 1]}` : ''}.`;
    if (style === 'empty') return `Group ${g}: an empty group.`;
    if (style === 'variable') return `Group ${g}: atoms for which atom-style variable ${a[0]} is non-zero.`;
    return '';
  },
  variable(c) {
    const [name, style, ...a] = c.args;
    const what = {
      index: `holds the values ${a.join(', ')}; next steps to the following one`, loop: `counts ${a.length >= 2 && isLammpsInteger(a[1]) ? `from ${a[0]} to ${a[1]}` : `from 1 to ${a[0]}`}; next steps it`,
      equal: `the formula ${a[0]}, evaluated each time it is used`, atom: `the per-atom formula ${a[0]}`, string: `the text "${a[0]}"`, delete: 'is deleted',
      vector: `the vector formula ${a[0]}`, internal: `the number ${a[0]} (set by commands such as fix controller)`, getenv: `the environment variable ${a[0]}`,
      file: `lines read from ${a[0]}`, format: `variable ${a[0]} printed with ${a[1]}`, world: 'one value per partition', universe: 'values shared out over partitions'
    }[style];
    return what ? `Variable ${name} ${style === 'delete' ? '' : '= '}${what}.` : '';
  },
  print(c) { return `Prints "${c.args[0]}"${c.args.includes('file') ? ` to ${c.args[c.args.indexOf('file') + 1]}` : ''}.`; },
  include(c) { return `Reads and runs the commands in ${c.args[0]}, then comes back here.`; },
  jump(c) { return `Continues reading ${c.args[0] === 'SELF' ? 'this file from the top' : c.args[0]}${c.args[1] ? ` at label ${c.args[1]}` : ''}.`; },
  label(c) { return `Marks a place that jump can go to (${c.args[0]}).`; },
  next(c) { return `Steps variable${c.args.length > 1 ? 's' : ''} ${listWords(c.args)} to the next value; when one runs out, the next jump is skipped (ending a loop).`; },
  if() { return 'Runs the commands after "then" when the condition is true (else the elif/else ones).'; },
  log(c) { return `Writes the log to ${c.args[0]}${c.args[1] === 'append' ? ' (appending)' : ''}.`; },
  clear() { return 'Deletes the system and all settings (variables stay), as if LAMMPS had just started.'; },
  newton(c) { return `Newton's third law across processors for pairs: ${c.args[0]}${c.args[1] ? `, for bonds: ${c.args[1]}` : ''}.`; },
  reset_timestep(c) { return `Sets the step counter to ${c.args[0]}.`; },
  displace_atoms(c) { return `Moves the atoms of group ${c.args[0]} (${c.args[1]}).`; },
  delete_atoms(c) { return `Deletes atoms (${c.args.slice(0, 2).join(' ')}).`; },
  replicate(c) { return `Copies the system ${c.args.slice(0, 3).join(' × ')} times.`; },
  change_box(c) { return `Changes the box of group ${c.args[0]}: ${c.args.slice(1).join(' ')}.`; },
  run_style(c) { return c.args[0] === 'verlet' ? 'Velocity Verlet time integration (the default).' : c.args[0] === 'respa' ? 'r-RESPA: several timesteps for fast and slow forces.' : ''; },
  dielectric(c) { return `Divides every Coulomb interaction by ${c.args[0]}.`; },
  comm_modify(c) { const k = kwMap(c.args, 0); return k.cutoff ? `Ghost atoms are kept up to ${c.q(k.cutoff, 'distance')} from each processor's domain.` : ''; },
  atom_modify(c) { const k = kwMap(c.args, 0); return k.map ? `Atom map: ${k.map} (lets commands look atoms up by ID).` : k.sort ? `Atoms are sorted in memory every ${k.sort} steps.` : ''; },
  processors(c) { return `Splits the box over processors as ${c.args.slice(0, 3).join(' × ')} (* = LAMMPS chooses).`; },
  echo(c) { return `Echoes each command to ${c.args[0]}.`; },
  shell(c) { return `Runs the shell command: ${c.args.join(' ')}.`; },
  quit() { return 'Stops LAMMPS here.'; }
};

/* keyword -> first value, for the words of a line from position `from`. */
function kwMap(words, from) {
  const out = {};
  for (let i = from; i < words.length - 1; i++) if (/^[a-z][a-z/0-9_]*$/.test(words[i]) && !isLammpsNumber(words[i])) out[words[i]] = out[words[i]] ?? words[i + 1];
  return out;
}

/* Pair styles: what the settings words mean. */
function pairMeaning(style, a, c) {
  const d = (w) => c.q(w, 'distance');
  const b = baseStyle(style);
  if (b === 'lj/cut') return `Lennard-Jones 12-6, cut off at ${d(a[0])}.`;
  if (b === 'lj/cut/coul/cut') return `Lennard-Jones cut off at ${d(a[0])} and Coulomb cut off at ${d(a[1] ?? a[0])}, with no long-range part.`;
  if (b === 'lj/cut/coul/long' || b === 'lj/cut/coul/msm') return `Lennard-Jones cut off at ${d(a[0])}; Coulomb split at ${d(a[1] ?? a[0])}, the rest computed by the kspace style.`;
  if (b === 'lj/cut/coul/dsf') return `Lennard-Jones cut off at ${d(a[1])}; Coulomb by the damped shifted force method (damping ${a[0]}), cut off at ${d(a[2] ?? a[1])}. No kspace needed.`;
  if (b === 'lj/cut/coul/debye') return `Lennard-Jones and screened Coulomb (Debye length 1/${a[0]}), cut off at ${d(a[1])}${a[2] ? ` and ${d(a[2])}` : ''}.`;
  if (b === 'lj/charmm/coul/long') return `CHARMM Lennard-Jones, switched off between ${d(a[0])} and ${d(a[1])}; Coulomb split at ${d(a[2] ?? a[1])}, the rest from the kspace style.`;
  if (b === 'lj/charmm/coul/charmm') return `CHARMM Lennard-Jones switched off between ${d(a[0])} and ${d(a[1])}; Coulomb switched off between ${d(a[2] ?? a[0])} and ${d(a[3] ?? a[1])}.`;
  if (b === 'lj/charmmfsw/coul/long') return `CHARMM Lennard-Jones with force switching between ${d(a[0])} and ${d(a[1])} (as in CHARMM36); Coulomb split at ${d(a[2] ?? a[1])}, the rest from kspace.`;
  if (b === 'lj/charmmfsw/coul/charmmfsh') return `CHARMM Lennard-Jones force-switched between ${d(a[0])} and ${d(a[1])}; Coulomb force-shifted to zero at ${d(a[2] ?? a[1])}.`;
  if (b === 'lj/cut/tip4p/long') return `TIP4P water: O type ${a[0]}, H type ${a[1]}, O-H bond type ${a[2]}, H-O-H angle type ${a[3]}, the charge site ${d(a[4])} from O along the bisector; LJ cut off at ${d(a[5])}, Coulomb split at ${d(a[6] ?? a[5])} with the rest from pppm/tip4p.`;
  if (b === 'lj/long/coul/long') return `Lennard-Jones (${a[0]} range) and Coulomb (${a[1]} range); cut-off ${d(a[2])}${a[3] ? `, Coulomb ${d(a[3])}` : ''}; "long" parts come from the kspace style.`;
  if (b === 'buck/coul/long') return `Buckingham plus Coulomb, cut off at ${d(a[0])}; Coulomb split at ${d(a[1] ?? a[0])}, the rest from kspace.`;
  if (b === 'buck') return `Buckingham (exp-6) potential, cut off at ${d(a[0])}.`;
  if (b === 'morse') return `Morse potential, cut off at ${d(a[0])}.`;
  if (b === 'soft') return `Soft cosine repulsion (to push overlapping atoms apart), cut off at ${d(a[0])}.`;
  if (b === 'coul/long') return `Coulomb only, split at ${d(a[0])}; the rest from kspace.`;
  if (b === 'coul/cut') return `Coulomb only, cut off at ${d(a[0])}.`;
  if (/^eam(\/alloy|\/fs|\/he|\/cd)?$/.test(b)) return `Embedded-atom method for metals; the parameters come from the potential file in pair_coeff${b === 'eam' ? ' (one funcfl file per type)' : ' (one setfl file for all types)'}.`;
  if (b === 'tersoff' || b === 'sw' || b === 'airebo' || b === 'rebo' || b === 'meam' || b === 'comb' || b === 'bop' || b === 'vashishta') return `Many-body potential ${b}; the parameters come from the file in pair_coeff * *.`;
  if (b === 'reaxff') return `ReaxFF reactive force field (bonds form and break); parameters from the force-field file in pair_coeff * *, charges from a fix qeq/reaxff (or acks2).`;
  if (/^hybrid/.test(b)) return `Combines the pair styles ${listWords((c.pairSubs.length ? c.pairSubs : a.filter(w => styleExists('pair_style', w))))}${b === 'hybrid' ? '; each pair of types uses one of them' : '; their forces add up (hybrid/overlay)'}.`;
  if (b === 'zero') return `No pair forces; neighbour lists are still built up to ${d(a[0])} (for computes that need them).`;
  if (b === 'table') return `Pair forces read from tables (${a[0]} interpolation with ${a[1]} points).`;
  return '';
}

function pairCoeffMeaning(style, a, c) {
  const [i, j, ...v] = a;
  const b = baseStyle(style);
  const types = i === '*' && j === '*' ? 'All type pairs' : i === j ? `Type ${i} with itself` : `Types ${i} and ${j}`;
  const e = (w) => c.q(w, 'energy');
  const d = (w) => c.q(w, 'distance');
  if (/^hybrid/.test(c.pair || '') && v.length) return `${types}, sub-style ${v[0]}: ${pairCoeffMeaning(v[0], [i, j, ...v.slice(1)], c).replace(/^[^:]*: /, '') || v.slice(1).join(' ')}`;
  if (/^(lj\/cut|lj\/cut\/coul\/(cut|long|msm|dsf|debye)|lj\/cut\/tip4p\/long|lj\/long\/coul\/long|lj\/class2(\/coul\/(cut|long))?|lj\/smooth\/linear|lj96\/cut|lj\/gromacs)$/.test(b)) {
    return `${types}: ε = ${e(v[0])}, σ = ${d(v[1])}${v[2] ? `, cut-off ${d(v[2])}` : ''}.`;
  }
  if (/^lj\/charmm(fsw)?\/coul/.test(b)) return `${types}: ε = ${e(v[0])}, σ = ${d(v[1])}${v[2] ? `; for 1-4 pairs ε = ${e(v[2])}, σ = ${d(v[3])}` : ''}.`;
  if (/^buck/.test(b)) return `${types}: A = ${e(v[0])}, ρ = ${d(v[1])}, C = ${v[2]} (energy × distance⁶).`;
  if (b === 'morse') return `${types}: D0 = ${e(v[0])}, α = ${v[1]} per distance, r0 = ${d(v[2])}.`;
  if (b === 'soft') return `${types}: A = ${e(v[0])}${v[1] ? `, cut-off ${d(v[1])}` : ''}.`;
  if (i === '*' && j === '*' && v.length && PAIR_INFO[b] && PAIR_INFO[b].mb) {
    const map = v.slice(1).map((el, k) => `type ${k + 1} = ${el === 'NULL' ? 'not this style' : el}`);
    return `Reads ${v[0]}${map.length ? `; ${map.join(', ')}` : ''}.`;
  }
  if (b === 'eam') return `${types}: reads ${v[0]} (the masses of these types also come from it).`;
  return '';
}

/* Bonded coefficients: K, r0 and friends in the input's units. */
function bondedCoeffMeaning(kind, style, a, c) {
  const [t, ...v] = a;
  const e = c.u ? c.u.energy : 'energy';
  const d = c.u ? c.u.distance : 'distance';
  if (kind === 'bond' && style === 'harmonic') return `Bond type ${t}: E = K (r - r0)² with K = ${v[0]} ${e}/${d}², r0 = ${v[1]} ${d} (LAMMPS's K includes the 1/2).`;
  if (kind === 'angle' && style === 'harmonic') return `Angle type ${t}: E = K (θ - θ0)² with K = ${v[0]} ${e}/rad², θ0 = ${v[1]}°.`;
  if (kind === 'angle' && style === 'charmm') return `Angle type ${t}: K = ${v[0]} ${e}/rad², θ0 = ${v[1]}°, Urey-Bradley K_ub = ${v[2]} ${e}/${d}², r_ub = ${v[3]} ${d}.`;
  if (kind === 'dihedral' && /^charmm/.test(style)) return `Dihedral type ${t}: E = K [1 + cos(n φ - d)] with K = ${v[0]} ${e}, n = ${v[1]}, d = ${v[2]}°, 1-4 weight ${v[3]}.`;
  if (kind === 'dihedral' && style === 'opls') return `Dihedral type ${t}: OPLS K1..K4 = ${v.slice(0, 4).join(', ')} ${e}.`;
  if (kind === 'dihedral' && style === 'harmonic') return `Dihedral type ${t}: E = K [1 + d cos(n φ)] with K = ${v[0]} ${e}, d = ${v[1]}, n = ${v[2]}.`;
  if (kind === 'improper' && style === 'harmonic') return `Improper type ${t}: E = K (χ - χ0)² with K = ${v[0]} ${e}/rad², χ0 = ${v[1]}°.`;
  if (kind === 'improper' && style === 'cvff') return `Improper type ${t}: E = K [1 + d cos(n χ)] with K = ${v[0]} ${e}, d = ${v[1]}, n = ${v[2]}.`;
  return '';
}

/* Fixes: what these values do. */
function fixMeaning(style, a, c) {
  const g = a[1];
  const b = baseStyle(style);
  const k = kwMap(a, 3);
  const T = (w) => c.q(w, 'temperature');
  const P = (w) => c.q(w, 'pressure');
  const after = (name, n) => { const i = a.indexOf(name); return i < 0 ? [] : a.slice(i + 1, i + 1 + n); };
  const on = `group ${g}`;
  if (b === 'nve') return `Moves the atoms of ${on} with velocity Verlet at constant energy (NVE): no thermostat.`;
  if (b === 'nvt' || b === 'npt' || b === 'nph') {
    const parts = [];
    const t = after('temp', 3);
    if (t.length === 3) parts.push(`Nosé-Hoover thermostat on ${on}: ${t[0] === t[1] ? `${T(t[0])} throughout` : `${T(t[0])} → ${T(t[1])} over the run`}, damping ${c.damp(t[2], '100 steps')}`);
    for (const p of ['iso', 'aniso', 'tri', 'x', 'y', 'z']) {
      const v = after(p, 3);
      if (v.length === 3) {
        const how = { iso: 'isotropic (one box scale)', aniso: 'anisotropic (x, y, z separately)', tri: 'fully flexible (triclinic)' }[p] || `along ${p}`;
        parts.push(`Nosé-Hoover barostat, ${how}: ${v[0] === v[1] ? P(v[0]) : `${P(v[0])} → ${P(v[1])}`}, damping ${c.damp(v[2], '1000 steps')}`);
        break;
      }
    }
    return `${parts.join('; ')}. It also moves the atoms (no fix nve needed).`;
  }
  if (b === 'langevin') return `Langevin thermostat on ${on}: random kicks and friction for ${a[3] === a[4] ? T(a[3]) : `${T(a[3])} → ${T(a[4])}`}, damping ${c.time(a[5])}, seed ${a[6]}${k.zero && /yes/.test(k.zero) ? ', no net random force' : ''}. It does not move atoms: pair it with fix nve.`;
  if (b === 'temp/berendsen') return `Berendsen thermostat on ${on}: rescales velocities towards ${a[3] === a[4] ? T(a[3]) : `${T(a[3])} → ${T(a[4])}`}, damping ${c.damp(a[5], '100 steps')}. Does not move atoms; not a proper canonical ensemble.`;
  if (b === 'temp/csvr') return `Bussi (CSVR) stochastic velocity rescaling on ${on}: ${T(a[3])}${a[3] !== a[4] ? ` → ${T(a[4])}` : ''}, damping ${c.damp(a[5], '100 steps')}, seed ${a[6]}. Canonical; does not move atoms (pair with fix nve).`;
  if (b === 'temp/rescale') return `Rescales the velocities of ${on} every ${a[3]} steps when the temperature is more than ${a[6]} from the target (${T(a[4])} → ${T(a[5])}). For equilibration only.`;
  if (b === 'press/berendsen') return `Berendsen barostat: rescales the box towards the target pressure. Does not move atoms.`;
  if (b === 'shake' || b === 'rattle') {
    const parts = [];
    const lists = { b: 'bond types', a: 'angle types', t: 'bonds to atom types', m: 'bonds to atoms of mass' };
    let mode = '';
    const got = { b: [], a: [], t: [], m: [] };
    for (const w of a.slice(6)) { if (w === 'mol' || w === 'kbond') break; if (lists[w]) mode = w; else if (mode) got[mode].push(w); }
    for (const m of ['b', 'a', 't', 'm']) {
      if (!got[m].length) continue;
      const light = got.m.some(x => Number(x) < 2);
      parts.push(m === 'm' ? `${lists.m} ${got.m.join(', ')} (within 0.1${light ? ', i.e. hydrogens' : ''})` : `${lists[m]} ${got[m].join(' ')}`);
    }
    return `${b === 'shake' ? 'SHAKE' : 'RATTLE'} holds rigid: ${parts.join('; ') || 'the listed bonds'}. Tolerance ${a[3]}, up to ${a[4]} iterations. This allows a 2 fs timestep in an all-atom model.`;
  }
  if (/^rigid/.test(b)) return `Treats ${a[3] === 'molecule' ? 'each molecule' : a[3] === 'single' ? `${on} as one body` : 'each body'} of ${on} as a rigid body${/nvt|npt|nph/.test(b) ? ', with its own thermostat/barostat' : ''}; it moves them (no fix nve on these atoms).`;
  if (b === 'momentum') return `Every ${a[3]} steps, removes the ${a.includes('angular') ? 'linear and angular' : 'linear'} momentum of ${on}.`;
  if (b === 'recenter') return `Shifts ${on} back so its centre of mass stays at (${a.slice(3, 6).join(', ')}).`;
  if (b === 'enforce2d') return 'Keeps the motion in the xy plane (zeroes z forces and velocities).';
  if (b === 'setforce') return `Sets the force on ${on} to (${a.slice(3, 6).join(', ')}) every step (NULL leaves a component unchanged).`;
  if (b === 'addforce') return `Adds the force (${a.slice(3, 6).join(', ')}) ${c.u ? c.u.force : ''} to each atom of ${on}.`;
  if (b === 'spring') return `A spring (${a[3]}) pulling ${on}.`;
  if (b === 'spring/self') return `Tethers each atom of ${on} to its starting position with K = ${a[3]}.`;
  if (b === 'viscous') return `Adds friction (−γ v, γ = ${a[3]}) to ${on}.`;
  if (b === 'deform') return `Changes the box shape or size every ${a[3]} steps (${a.slice(4).join(' ')}).`;
  if (b === 'box/relax') return 'Lets the box relax towards the target pressure during minimisation.';
  if (b === 'ave/time') return `Averages ${listWords(a.filter(w => /^[cfv]_/.test(w)))}: samples every ${a[3]} steps, ${a[4]} samples, output every ${plural(a[5], 'step')}${c.span(a[5]) ? ` (${c.span(a[5])})` : ''}${k.file ? ` to ${k.file}` : ''}.`;
  if (b === 'ave/chunk') return `Averages per chunk (compute ${a[6]}): every ${a[3]} steps, ${a[4]} samples, output every ${a[5]} steps${k.file ? ` to ${k.file}` : ''}.`;
  if (b === 'print') return `Prints "${a[4]}" every ${a[3]} steps.`;
  if (b === 'plumed') return `Runs PLUMED with the input ${k.plumedfile || 'plumed.dat'}${k.outfile ? ` (log ${k.outfile})` : ''}: collective variables and biases act on the atoms.`;
  if (b === 'wall/reflect') return `Reflecting walls: atoms that cross ${a.slice(3).join(' ')} bounce back.`;
  if (b === 'gravity') return `Gravity on ${on} (${a.slice(3).join(' ')}).`;
  if (b === 'efield') return `An external electric field (${a.slice(3, 6).join(', ')}) ${c.u ? c.u.efield || '' : ''} on ${on}.`;
  if (b === 'qeq/reaxff') return `Charge equilibration for ReaxFF every ${a[3]} steps (tolerance ${a[6]}).`;
  if (b === 'property/atom') return `Adds per-atom properties: ${a.slice(3).join(' ')}.`;
  return '';
}

function computeMeaning(style, a) {
  const [id, g] = a;
  const b = baseStyle(style);
  const head = `Compute ${id} on group ${g}: `;
  const m = {
    temp: 'the temperature', pe: 'the potential energy', ke: 'the kinetic energy', pressure: `the pressure (using temperature compute ${a[3]})`,
    msd: 'the mean squared displacement', rdf: `the radial distribution function with ${a[3]} bins`, 'pe/atom': 'the potential energy of each atom',
    'ke/atom': 'the kinetic energy of each atom', 'stress/atom': 'the stress × volume of each atom', com: 'the centre of mass', gyration: 'the radius of gyration',
    'chunk/atom': `a chunk ID for each atom (${a[3]})`, 'property/atom': `per-atom values: ${a.slice(3).join(' ')}`, reduce: `the ${a[3]} of ${a.slice(4).filter(w => !/^(replace|inputs)$/.test(w)).join(', ')}`,
    'temp/com': 'the temperature without the centre-of-mass motion', 'temp/partial': 'the temperature of chosen velocity components',
    'coord/atom': 'the coordination number of each atom', 'cluster/atom': 'a cluster ID for each atom', 'displace/atom': 'how far each atom has moved', vacf: 'the velocity autocorrelation function'
  }[b];
  return m ? `${head}${m}.` : '';
}

function dumpMeaning(style, a, c) {
  const [, g, , every, file, ...cols] = a;
  const t = c.span(every);
  const head = `Writes group ${g} every ${plural(every, 'step')}${t ? ` (every ${t})` : ''} to ${file}`;
  const b = baseStyle(style);
  if (b === 'custom' || b === 'yaml') return `${head} with the columns ${cols.map(w => DUMP_COLUMN_WORDS[w] || w).join(', ')}.`;
  if (b === 'atom') return `${head}: atom ID, type and scaled coordinates.`;
  if (b === 'xyz') return `${head} in XYZ format (element or type and coordinates).`;
  if (b === 'dcd' || b === 'xtc') return `${head} as a compact binary ${b.toUpperCase()} trajectory (coordinates only; VMD and MDAnalysis read it).`;
  if (b === 'local') return `${head}: per-bond or per-pair values ${cols.join(', ')}.`;
  if (b === 'image' || b === 'movie') return `${head} as ${b === 'image' ? 'images' : 'a movie'}.`;
  return `${head}.`;
}

/* The generic explanation: the summary plus the keyword/value pairs named. */
function genericMeaning(info, words) {
  if (!info) return '';
  const names = new Set((info.keywords || []).map(k => k.name));
  const parts = [];
  for (let i = 0; i < words.length; i++) {
    if (names.has(words[i])) {
      const kw = info.keywords.find(k => k.name === words[i]);
      const n = kw.values ? kw.values.length : 0;
      const vals = words.slice(i + 1, i + 1 + n);
      parts.push(n && kw.values ? `${words[i]} = ${vals.join(' ')} (${kw.values.join(', ')})` : words[i]);
      i += n;
    }
  }
  return parts.length ? `Keywords: ${parts.join('; ')}.` : '';
}

/* The command that selects a style, and which word holds it. */
const STYLE_SLOT = {
  fix: ['fix', 2], compute: ['compute', 2], dump: ['dump', 2], region: ['region', 1], pair_style: ['pair_style', 0], bond_style: ['bond_style', 0],
  angle_style: ['angle_style', 0], dihedral_style: ['dihedral_style', 0], improper_style: ['improper_style', 0], kspace_style: ['kspace_style', 0],
  atom_style: ['atom_style', 0], min_style: ['min_style', 0], run_style: ['run_style', 0]
};

/**
 * Explain an input line by line: what each command does with these values,
 * in the units of the script, with its documentation link and the issues
 * {@link checkInput} found on it.
 *
 * Rows of included files (given in `options.files`) follow the rows of the
 * main input, in the order they were first included, and carry `file`.
 *
 * @param {string|ReturnType<typeof parseInput>} input
 * @param {object} [options] - As for {@link checkInput} (packages, vars, files, data, restart).
 * @returns {Array<{line:number, lastLine:number, file?:string, kind:'command'|'comment'|'blank', text:string,
 *   command:string, style:string, title:string, summary:string, meaning:string, url:string, package:string|null,
 *   status:'ok'|'unknown'|'error'|'warning', issues:LammpsIssue[], comment:string}>}
 */
export function explainInput(input, options = {}) {
  const parsed = typeof input === 'string' || input == null ? parseInput(input) : input;
  const checked = checkInput(parsed, options);
  const contexts = checked.contexts;
  const byLine = new Map();
  for (const i of checked.issues) {
    const k = `${i.file || ''}|${i.line}`;
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(i);
  }
  const rows = [];
  let last = { units: options.restart && options.restart.units ? options.restart.units : DEFAULT_UNITS, dt: null, pair: null, pairSubs: [] };
  const explainLines = (lines, file) => {
    for (const l of lines) {
      const key = `${file || ''}|${l.line}`;
      const ctx = contexts.get(key) || null;
      if (ctx) last = ctx;
      rows.push(explainRow(l, file, ctx, last, byLine.get(key) || []));
    }
  };
  explainLines(parsed.lines, '');
  for (const [name, p] of checked.includedFiles) explainLines(p.lines, name);
  return rows;
}

function explainRow(l, file, ctx, last, issues) {
  const row = {
    line: l.line, lastLine: l.lastLine, kind: l.kind, text: l.raw, command: l.command || '', style: '', title: l.command || '',
    summary: '', meaning: '', url: '', package: null, status: 'ok', issues, comment: l.comment || ''
  };
  if (file) row.file = file;
  if (l.kind === 'comment') { row.meaning = 'A comment: LAMMPS ignores everything after #.'; return row; }
  if (l.kind === 'blank') return row;
  const cmd = l.command;
  const words = ctx && ctx.command === cmd ? ctx.args : l.args;
  const slot = STYLE_SLOT[cmd];
  let info = null;
  if (slot) {
    row.style = words[slot[1]] || '';
    row.title = `${cmd === 'region' ? 'region' : cmd} ${row.style}`.trim();
    info = row.style ? commandInfo(slot[0], row.style) : null;
  }
  if (!info) info = META.has(cmd) ? commandInfo(cmd) : commandInfo(cmd);
  if (info) {
    row.summary = info.summary || '';
    row.url = info.url || lammpsDocUrl(cmd, row.style) || '';
    row.package = info.package || null;
  } else row.url = lammpsDocUrl(cmd) || '';
  if (cmd === 'body' || (cmd === 'atom_style' && row.style === 'body' && words[1])) row.title = `atom_style body ${words[1]}`;
  const c = lineContext({ ...(ctx || last), args: words });
  let meaning = '';
  try {
    if (cmd === 'pair_style') meaning = pairMeaning(words[0], words.slice(1), c);
    else if (cmd === 'pair_coeff') meaning = pairCoeffMeaning(c.pair || '', words, c);
    else if (/^(bond|angle|dihedral|improper)_coeff$/.test(cmd)) {
      const kind = cmd.split('_')[0];
      const st = c.bonded && c.bonded[kind] ? c.bonded[kind].style : '';
      meaning = bondedCoeffMeaning(kind, st === 'hybrid' ? words[1] : st, st === 'hybrid' ? [words[0], ...words.slice(2)] : words, c);
    } else if (cmd === 'fix') meaning = fixMeaning(words[2] || '', words, c);
    else if (cmd === 'compute') meaning = computeMeaning(words[2] || '', words);
    else if (cmd === 'dump') meaning = dumpMeaning(words[2] || '', words, c);
    else if (MEANINGS[cmd]) meaning = MEANINGS[cmd](c);
  } catch {
    meaning = '';
  }
  if (!meaning && info) {
    // The generic explanation: the style's summary, then its keywords with their values.
    const rest = slot ? words.slice(slot[1] + 1) : words;
    meaning = [info.summary, genericMeaning(info, rest)].filter(Boolean).join(' ');
  }
  if (!info && !META.has(cmd)) {
    row.status = 'unknown';
    if (!meaning) meaning = 'Not a LAMMPS command.';
  }
  if (info && info.removed) meaning = `${info.removed.note}${meaning ? ` ${meaning}` : ''}`;
  if (l.hasVars && ctx) meaning = `${meaning}${meaning ? ' ' : ''}(With the variables in: ${[cmd, ...words].join(' ')}.)`;
  else if (l.hasVars && !ctx) meaning = `${meaning}${meaning ? ' ' : ''}(This line did not run while checking, so its $ values are not known.)`;
  row.meaning = meaning;
  if (issues.some(i => i.severity === 'error')) row.status = 'error';
  else if (issues.some(i => i.severity === 'warning')) row.status = row.status === 'unknown' ? 'unknown' : 'warning';
  return row;
}

/**
 * Explain the inputs of a workflow in the order they run, each with what
 * the earlier stages' restart files bring back (see {@link checkChain}), so
 * a stage that starts with read_restart is explained in its real units.
 *
 * @param {Array<{name:string, text:string}>} stages
 * @param {object} [options] - As for {@link checkInput}.
 * @returns {Array<{name:string, rows:ReturnType<typeof explainInput>}>}
 */
export function explainChain(stages, options = {}) {
  const restartStates = new Map(options.restartStates || []);
  const out = [];
  for (const stage of stages) {
    const before = new Map(restartStates);
    const r = checkInput(stage.text, { ...options, restartStates: before });
    for (const [k, v] of r.savedRestarts || []) restartStates.set(k, { ...v, from: `${v.from} in ${stage.name}` });
    out.push({ name: stage.name, rows: explainInput(stage.text, { ...options, restartStates: before }) });
  }
  return out;
}
