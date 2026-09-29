/**
 * @module core/plumed-parse
 *
 * Reading a PLUMED input that already exists: parse it, say what is wrong with
 * it, explain it line by line, and turn it into a description the builder in
 * `plumed.js` can edit.
 *
 * The parser follows PLUMED's own rules (tools/Tools.cpp, `getParsedLine`):
 *
 *   - `#` starts a comment that runs to the end of the line;
 *   - a line ending in `...` opens a block that continues until a line starting
 *     with `...`, which may repeat the first word of the block and nothing else;
 *   - words are separated by blanks, except inside `{ }`, which may nest;
 *   - an action is labelled `label: ACTION ...` or `ACTION LABEL=label ...`;
 *   - action names and keywords may be written in either case;
 *   - `ENDPLUMED` ends the input, whatever follows it.
 *
 * The checks that need to know the language, which keywords an action has and
 * which module it lives in, take a table from `plumed-syntax.js`. They were
 * tuned on the input files of PLUMED's regression tests, which all parse, so a
 * message about one of them is a false alarm.
 */

import { CV_DEFS, FUNCTION_DEFS, BIAS_DEFS } from './plumed-catalogue.js';
import { parseAtomList, defaultBiasValues, LENGTH_IN_NM } from './plumed.js';

const ACTION_RE = /^[A-Z][A-Z0-9_]*$/;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

/**
 * Remove a comment. A `#` inside braces is still a comment to PLUMED.
 *
 * @param {string} line
 * @returns {{code:string, comment:string}}
 */
export function stripComment(line) {
  const s = String(line == null ? '' : line);
  const i = s.indexOf('#');
  if (i < 0) return { code: s, comment: '' };
  return { code: s.slice(0, i), comment: s.slice(i + 1).trim() };
}

/**
 * Split a line into words, keeping a `{ ... }` group together.
 *
 * @param {string} text
 * @returns {{words:string[], unbalanced:boolean}}
 */
export function splitWords(text) {
  const words = [];
  let cur = '';
  let depth = 0;
  let unbalanced = false;
  for (const ch of String(text == null ? '' : text)) {
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth < 0) { unbalanced = true; depth = 0; }
    }
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) { words.push(cur); cur = ''; }
    } else {
      cur += /\s/.test(ch) ? ' ' : ch;
    }
  }
  if (cur) words.push(cur);
  if (depth !== 0) unbalanced = true;
  return { words, unbalanced };
}

/**
 * Split `KEY=value` at the first `=`. A word without one is a flag.
 * The outer braces of a value are removed, as PLUMED does.
 *
 * @param {string} word
 * @returns {{key:string, value:string|null, braced:boolean}}
 */
export function splitKeyword(word) {
  const w = String(word);
  const i = w.indexOf('=');
  if (i < 0) return { key: w, value: null, braced: false };
  let value = w.slice(i + 1);
  let braced = false;
  if (value.startsWith('{') && value.endsWith('}')) {
    value = value.slice(1, -1).trim();
    braced = true;
  }
  return { key: w.slice(0, i), value, braced };
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} ParsedAction
 * @property {string} action - Action name, e.g. `METAD`.
 * @property {string} label - Its label, or '' when it has none.
 * @property {number} line - First line, counted from 1.
 * @property {number} endLine - Last line.
 * @property {Array<{key:string, value:string|null, braced:boolean}>} keywords
 * @property {boolean} block - Written over several lines with `...`.
 * @property {string[]} comments - Comments directly above the action.
 */

/**
 * Parse a PLUMED input.
 *
 * @param {string} text
 * @returns {{actions:ParsedAction[], errors:Array<{line:number, text:string}>,
 *   ended:number|null}} `ended` is the line of `ENDPLUMED`, if there is one.
 */
export function parsePlumedInput(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const actions = [];
  const errors = [];
  let ended = null;
  let comments = [];

  const depthOf = (code) => {
    let d = 0;
    for (const ch of code) {
      if (ch === '{') d += 1;
      else if (ch === '}') d -= 1;
    }
    return d;
  };

  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const { code, comment } = stripComment(lines[i]);
    i += 1;

    if (!code.trim()) {
      if (comment) comments.push(comment);
      else comments = [];
      continue;
    }
    const firstWord = code.trim().split(/\s+/)[0];
    if (firstWord === 'ENDPLUMED') {
      ended = lineNo;
      break;
    }
    if (firstWord === '...') {
      errors.push({ line: lineNo, text: 'A line starts with `...` but no block is open.' });
      comments = [];
      continue;
    }
    // Directives of the multi-replica driver, not actions.
    if (/^_SET_/.test(firstWord)) {
      comments = [];
      continue;
    }

    let body = code;
    let endLine = lineNo;
    let block = false;

    if (/(^|\s)\.\.\.\s*$/.test(code)) {
      block = true;
      body = code.replace(/\.\.\.\s*$/, ' ');
      const first = body.trim().split(/\s+/)[0] || '';
      let closed = false;
      while (i < lines.length) {
        const n = i + 1;
        const part = stripComment(lines[i]).code;
        i += 1;
        const words = part.trim().split(/\s+/).filter(Boolean);
        if (words[0] === '...') {
          closed = true;
          endLine = n;
          const rest = words.slice(1);
          if (rest.length > 1) {
            errors.push({
              line: n,
              text: 'The line that closes a block holds `...` and at most one word after it.'
            });
          } else if (rest.length === 1 && rest[0] !== first) {
            errors.push({
              line: n,
              text: `The block opened with \`${first}\` is closed with \`... ${rest[0]}\`. ` +
                'PLUMED stops here: the word after the dots must repeat the first word of ' +
                `the block, \`${first}\`, or be left out.`
            });
          }
          break;
        }
        body += ` ${part}`;
        if (words.length) endLine = n;
      }
      if (!closed) {
        errors.push({
          line: lineNo,
          text: `The block opened with \`${first}\` is never closed. End it with a line holding \`...\`.`
        });
      }
    } else {
      // A brace left open carries the value over to the next lines.
      while (depthOf(body) > 0 && i < lines.length) {
        body += ` ${stripComment(lines[i]).code}`;
        endLine = i + 1;
        i += 1;
      }
    }

    const split = splitWords(body);
    let all = split.words;
    if (split.unbalanced) {
      errors.push({ line: lineNo, text: 'Unbalanced braces: a `{` has no matching `}`.' });
    }
    if (!all.length) {
      comments = [];
      continue;
    }

    let label = '';
    if (all.length && all[0].endsWith(':') && all[0].length > 1) {
      label = all[0].slice(0, -1);
      all = all.slice(1);
    }
    // PLUMED reads names and keywords in either case; values keep theirs.
    const written = all[0] || '';
    const action = /^[A-Za-z][A-Za-z0-9_]*$/.test(written) ? written.toUpperCase() : written;
    const keywords = all.slice(1).map(splitKeyword).map(k => ({ ...k, key: k.key.toUpperCase() }));

    const named = keywords.findIndex(k => k.key === 'LABEL' && k.value !== null);
    if (named > -1) {
      if (label) {
        errors.push({
          line: lineNo,
          text: `\`${action}\` is labelled twice, with \`${label}:\` and with \`LABEL=\`. Keep one.`
        });
      } else {
        label = keywords[named].value;
      }
      keywords.splice(named, 1);
    }

    if (!action) {
      errors.push({ line: lineNo, text: `The label \`${label}\` is not followed by an action.` });
    } else if (!ACTION_RE.test(action)) {
      errors.push({
        line: lineNo,
        text: `\`${action}\` cannot be an action name: PLUMED actions are written in capitals.`
      });
    }
    actions.push({ action, label, line: lineNo, endLine, keywords, block, comments });
    comments = [];
  }
  return { actions, errors, ended };
}

/** First value of a keyword, or '' when it is absent. */
export function keywordValue(action, key) {
  const k = (action.keywords || []).find(x => x.key === key);
  return k && k.value !== null ? k.value : '';
}

/** Is a flag set on an action? */
export function hasFlag(action, key) {
  return (action.keywords || []).some(x => x.key === key && x.value === null);
}

function listOf(value) {
  return str(value).split(',').map(str).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * What an action refers to
 * ------------------------------------------------------------------ */

/**
 * The label a reference points at: `cn.morethan-1` and `cn_morethan-1` both
 * point at `cn` when `cn` is an action.
 *
 * @param {string} ref
 * @param {Set<string>} labels
 * @returns {string|null} Null when nothing defined matches.
 */
export function resolveReference(ref, labels) {
  const r = str(ref);
  if (!r) return null;
  if (labels.has(r)) return r;
  const dot = r.indexOf('.');
  if (dot > 0 && labels.has(r.slice(0, dot))) return r.slice(0, dot);
  // Shortcuts name the actions they create after their own label: label_mean,
  // label-1_mean, label1.
  let best = null;
  for (const l of labels) {
    if (r.length > l.length && r.startsWith(l) && /[_\-.\d]/.test(r[l.length]) &&
      (!best || l.length > best.length)) best = l;
  }
  return best;
}

function isLiteralReference(ref) {
  const r = str(ref);
  return /[*?()]/.test(r) || r.startsWith('@') || /^[-+]?(\d|\.\d)/.test(r);
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

const SETUP_ACTIONS = new Set(['RESTART', 'UNITS', 'LOAD', 'INCLUDE']);
/* Actions PLUMED allows anywhere, so a setup action may follow them. */
const ANY_ORDER = new Set(['MOLINFO', 'DEBUG', 'ENDPLUMED']);
const METAD_FAMILY = new Set(['METAD', 'PBMETAD', 'OPES_METAD', 'OPES_METAD_EXPLORE']);
const PER_ARG = {
  METAD: ['SIGMA', 'GRID_MIN', 'GRID_MAX', 'GRID_BIN', 'GRID_SPACING', 'SIGMA_MIN', 'SIGMA_MAX'],
  PBMETAD: ['SIGMA', 'GRID_MIN', 'GRID_MAX', 'GRID_BIN', 'GRID_SPACING', 'FILE'],
  OPES_METAD: ['SIGMA', 'SIGMA_MIN'],
  RESTRAINT: ['AT', 'KAPPA', 'SLOPE'],
  UPPER_WALLS: ['AT', 'KAPPA', 'OFFSET', 'EXP', 'EPS'],
  LOWER_WALLS: ['AT', 'KAPPA', 'OFFSET', 'EXP', 'EPS'],
  MOVINGRESTRAINT: ['AT0', 'KAPPA0', 'AT1', 'KAPPA1'],
  ABMD: ['TO', 'KAPPA', 'NOISE', 'SEED', 'MIN'],
  COMBINE: ['COEFFICIENTS', 'PARAMETERS', 'POWERS']
};
/* Keywords every action of a kind takes, which the table lists for some only. */
const EVERYWHERE = new Set(['NUMERICAL_DERIVATIVES', 'NOPBC', 'SERIAL', 'TIMINGS', 'LOWMEM', '__FILL__']);

/* Keywords whose words are atoms or the labels of groups and centres. */
const ATOM_KEYS = /^(ATOMS?|GROUP[ABC]?|SPECIES[AB]?|ENTITY|CENTER|ORIGIN|AXIS_ATOMS|VECTORSTART|VECTOREND|CATOMS)\d*$/;

const SWITCH_NAMES = new Set([
  'RATIONAL', 'EXP', 'GAUSSIAN', 'SMAP', 'Q', 'CUBIC', 'TANH', 'COSINUS', 'CUSTOM', 'MATHEVAL',
  'NATIVEQ', 'FAST_RATIONAL', 'COSINE'
]);

/**
 * @typedef {object} Issue
 * @property {'error'|'warning'|'note'} level - An error stops PLUMED; a
 *           warning lets it run and may give a wrong result; a note is advice.
 * @property {number} line
 * @property {string} text
 */

/**
 * Check a PLUMED input.
 *
 * @param {string} text
 * @param {{syntax?:object, natoms?:number, includes?:boolean}} [options]
 *        `syntax` is a table from `plumed-syntax.js`; without it only the
 *        structure is checked.
 * @returns {{issues:Issue[], parsed:ReturnType<typeof parsePlumedInput>,
 *   summary:{actions:number, errors:number, warnings:number, notes:number}}}
 */
export function lintPlumedInput(text, options = {}) {
  const { syntax = null, natoms = 0 } = options;
  const parsed = parsePlumedInput(text);
  const issues = parsed.errors.map(e => ({ level: 'error', ...e }));
  const add = (level, line, message) => issues.push({ level, line, text: message });

  const actions = parsed.actions.filter(a => a.action && ACTION_RE.test(a.action));
  const loads = actions.some(a => a.action === 'LOAD');
  const includes = actions.some(a => a.action === 'INCLUDE');
  // With an INCLUDE the file is not the whole input, so a label it does not
  // define may well exist.
  const open = includes || !!options.includes;

  const labels = new Set();
  const seenAt = new Map();
  let units = { length: 'nm' };
  let sawAction = false;
  const modules = new Map();

  for (const a of actions) {
    const s = syntax && syntax.has(a.action) ? syntax : null;

    /* --- order of setup actions --- */
    if (SETUP_ACTIONS.has(a.action)) {
      if (sawAction && a.action !== 'INCLUDE' && a.action !== 'LOAD') {
        add('error', a.line,
          `\`${a.action}\` is a setup action and must come before every other action. ` +
          'Move it to the top of the file.');
      }
    } else if (!ANY_ORDER.has(a.action)) {
      sawAction = true;
    }
    if (a.action === 'UNITS') {
      const l = keywordValue(a, 'LENGTH');
      if (l) units = { length: l };
    }

    /* --- the action itself --- */
    if (syntax && !s) {
      if (loads && !nearestAction(a.action, syntax)) {
        add('note', a.line,
          `\`${a.action}\` is not part of PLUMED ${syntax.version}; it is taken to come from a ` +
          '`LOAD` file, so its keywords are not checked.');
      } else {
        const near = nearestAction(a.action, syntax);
        add(near ? 'error' : 'warning', a.line, near
          ? `\`${a.action}\` is not an action of PLUMED ${syntax.version}. Did you mean \`${near}\`?`
          : `\`${a.action}\` is not in the keyword table of PLUMED ${syntax.version}. Check the ` +
            'name and the target version; an action of a module that needs an extra library ' +
            'is not listed.');
      }
    }
    if (s) {
      const m = s.moduleOf(a.action);
      if (m && !m.defaultOn) {
        if (!modules.has(m.name)) modules.set(m.name, { line: a.line, actions: [] });
        const entry = modules.get(m.name);
        if (!entry.actions.includes(a.action)) entry.actions.push(a.action);
      }
      const seen = new Set();
      for (const k of a.keywords) {
        const kw = s.keyword(a.action, k.key);
        if (!kw) {
          if (EVERYWHERE.has(k.key)) continue;
          const near = nearestKeyword(k.key, s.action(a.action).keywords.map(x => x.name));
          add('warning', a.line,
            `\`${k.key}\` is not a keyword the table of PLUMED ${syntax.version} lists for ` +
            `\`${a.action}\`.` + (near ? ` Did you mean \`${near}\`?` : '') +
            ' PLUMED stops at a word it cannot understand, so check the line with ' +
            '`plumed driver --parse-only`.');
          continue;
        }
        if (kw.style === 'flag' && k.value !== null) {
          add('warning', a.line,
            `\`${k.key}\` is a flag of \`${a.action}\`: write it alone, without \`=${k.value}\`.`);
        }
        // A reduction such as MEAN is written alone; MORE_THAN takes a value.
        if (kw.style !== 'flag' && kw.style !== 'reduction' && k.value === null) {
          add('error', a.line, `\`${k.key}\` of \`${a.action}\` needs a value: \`${k.key}=...\`.`);
        }
        if (k.value !== null && k.value === '') {
          add('error', a.line, `\`${k.key}=\` of \`${a.action}\` has no value.`);
        }
        if (seen.has(k.key)) {
          add('error', a.line, `\`${k.key}\` is given twice on \`${a.action}\`.`);
        }
        seen.add(k.key);
      }
    }

    /* --- label --- */
    if (a.label) {
      if (labels.has(a.label)) {
        add('error', a.line,
          `The label \`${a.label}\` is used twice, first on line ${seenAt.get(a.label)}. ` +
          'PLUMED requires unique labels.');
      }
      if (a.label.includes('.')) {
        add('error', a.line,
          `The label \`${a.label}\` contains a dot, which PLUMED reads as a component.`);
      }
      if (a.label.startsWith('@')) {
        add('error', a.line, `The label \`${a.label}\` starts with @, which PLUMED reserves.`);
      }
    }

    /* --- what it refers to --- */
    for (const k of a.keywords) {
      if (k.value === null) continue;
      const style = s ? (s.keyword(a.action, k.key) || {}).style : null;
      if (/^ARG\d*$/.test(k.key) && style !== 'atoms' && !k.braced) {
        for (const ref of listOf(k.value)) {
          if (isLiteralReference(ref) || open || k.value.includes('@replicas')) continue;
          if (!resolveReference(ref, labels)) {
            const later = actions.find(x => x.label && resolveReference(ref, new Set([x.label])));
            add('error', a.line, later
              ? `\`${a.action}\` uses \`${ref}\`, which is only defined on line ${later.line}. ` +
                'PLUMED reads the file in order: move the definition above this line.'
              : `\`${a.action}\` uses \`${ref}\`, which nothing in the file defines.`);
          }
        }
      }
      if (style === 'atoms') {
        const parsedAtoms = parseAtomList(k.value);
        if (parsedAtoms.indices.includes(0)) {
          add('error', a.line, `\`${k.key}\` of \`${a.action}\` names atom 0. PLUMED counts atoms from 1.`);
        }
        if (natoms && parsedAtoms.indices.length) {
          const max = parsedAtoms.indices.reduce((x, y) => Math.max(x, y), 0);
          if (max > natoms) {
            add('error', a.line,
              `\`${k.key}\` of \`${a.action}\` names atom ${max}, but the system has ${natoms} atoms.`);
          }
        }
        if (!open && ATOM_KEYS.test(k.key)) {
          for (const l of parsedAtoms.labels) {
            if (l.startsWith('@') || labels.has(l) || resolveReference(l, labels)) continue;
            add('error', a.line,
              `\`${k.key}\` of \`${a.action}\` uses \`${l}\`, which is not a group or a centre ` +
              'defined above it.');
          }
        }
        if (parsedAtoms.labels.some(l => /^@(phi|psi|omega|chi\d|back|sidechain|protein|nucleic|water|ions|hydrogens|nonhydrogens)/.test(l)) &&
          !actions.some(x => x.action === 'MOLINFO' && x.line < a.line)) {
          add('error', a.line,
            `\`${a.action}\` uses a \`@\` selection, which needs a \`MOLINFO\` line above it.`);
        }
      }
      /* --- switching functions in reduced units --- */
      if (k.braced || ['R_0', 'D_0', 'D_MAX'].includes(k.key)) {
        const nm = LENGTH_IN_NM[units.length] || (Number(units.length) > 0 ? Number(units.length) : 1);
        const pairs = k.braced
          ? splitWords(k.value).words.map(splitKeyword)
          : [{ key: k.key, value: k.value }];
        const isSwitch = !k.braced || SWITCH_NAMES.has((splitWords(k.value).words[0] || '').toUpperCase());
        const onDistance = /^(SWITCH|SWITCH\d+|SWITCHA|SWITCHB|R_0|D_0|D_MAX)$/.test(k.key);
        if (isSwitch && onDistance) {
          const get = (n) => {
            const p = pairs.find(x => x.key === n);
            return p && p.value !== null && Number.isFinite(Number(p.value)) ? Number(p.value) : null;
          };
          const r0 = get('R_0');
          const d0 = get('D_0') || 0;
          const dmax = get('D_MAX');
          if (r0 !== null && r0 <= 0) {
            add('error', a.line, `\`R_0\` in \`${k.key}\` of \`${a.action}\` must be positive.`);
          }
          if (dmax !== null && dmax <= d0) {
            add('error', a.line, `\`D_MAX\` in \`${k.key}\` of \`${a.action}\` must be larger than \`D_0\`.`);
          }
          const far = Math.max(r0 || 0, d0, dmax || 0) * nm;
          if (far > 2.5 && units.length === 'nm') {
            add('note', a.line,
              `The switching function of \`${a.action}\` reaches ${far.toFixed(1)} nm, far beyond a ` +
              'first coordination shell. If the value was copied from an example in reduced ' +
              'units, convert it.');
          }
        }
      }
    }

    /* --- one value per argument --- */
    const per = PER_ARG[a.action];
    const args = listOf(keywordValue(a, 'ARG'));
    // Adaptive hills take one width for all; partitioned families and vector
    // arguments pair values with something other than the argument list.
    const fixedCount = args.length > 1 && !args.some(isLiteralReference) &&
      !keywordValue(a, 'ADAPTIVE') && !a.keywords.some(k => /^PF\d+$/.test(k.key));
    if (per && fixedCount) {
      for (const key of per) {
        const v = keywordValue(a, key);
        if (!v || /^ADAPTIVE$/i.test(v) || v.includes('@replicas')) continue;
        const n = listOf(v).length;
        const single = ['KAPPA', 'EXP', 'EPS', 'OFFSET', 'SLOPE'].includes(key) && n === 1 && args.length > 1;
        if (n !== args.length) {
          add(single ? 'warning' : 'error', a.line,
            `\`${a.action}\` has ${args.length} argument${args.length === 1 ? '' : 's'} but ` +
            `\`${key}\` has ${n} value${n === 1 ? '' : 's'}. PLUMED needs one per argument.`);
        }
      }
    }

    /* --- metadynamics --- */
    if (a.action === 'METAD' || a.action === 'PBMETAD') {
      const gmin = keywordValue(a, 'GRID_MIN');
      const gmax = keywordValue(a, 'GRID_MAX');
      if (!gmin !== !gmax) {
        add('error', a.line, `\`${a.action}\` needs both \`GRID_MIN\` and \`GRID_MAX\`, or neither.`);
      }
      if (!gmin && !gmax) {
        add('note', a.line,
          `\`${a.action}\` has no grid. Every step then sums over every hill deposited so far, ` +
          'so the run slows down as it proceeds. Add `GRID_MIN` and `GRID_MAX`.');
      }
      if (gmin && gmax) {
        const lo = listOf(gmin);
        const hi = listOf(gmax);
        const sg = listOf(keywordValue(a, 'SIGMA'));
        const nb = listOf(keywordValue(a, 'GRID_BIN'));
        lo.forEach((l, j) => {
          const x = numberOf(l);
          const y = numberOf(hi[j]);
          if (x === null || y === null) return;
          if (y <= x) {
            add('error', a.line,
              `\`${a.action}\`: \`GRID_MAX\` (${hi[j]}) is not above \`GRID_MIN\` (${l}) for ` +
              `\`${args[j] || `argument ${j + 1}`}\`.`);
            return;
          }
          const s0 = numberOf(sg[j]);
          const b = numberOf(nb[j]);
          if (s0 && b && (y - x) / b > s0 / 2) {
            add('note', a.line,
              `\`${a.action}\`: the grid spacing for \`${args[j] || `argument ${j + 1}`}\` is ` +
              `${((y - x) / b).toPrecision(3)}, more than half of \`SIGMA\` (${sg[j]}). A hill is ` +
              `then poorly resolved; use at least ${Math.ceil((y - x) / (s0 / 2))} bins.`);
          }
        });
      }
      if (keywordValue(a, 'BIASFACTOR') && !keywordValue(a, 'TEMP')) {
        add('note', a.line,
          `\`${a.action}\` sets \`BIASFACTOR\` without \`TEMP\`. PLUMED then takes the temperature ` +
          'from the MD engine, which not every engine passes; set `TEMP` to be sure.');
      }
      const bf = numberOf(keywordValue(a, 'BIASFACTOR'));
      if (bf !== null && bf <= 1) {
        add('error', a.line, `\`BIASFACTOR\` must be larger than 1; it is ${bf}.`);
      }
      if (hasFlag(a, 'CALC_RCT') && !gmin) {
        add('error', a.line, '`CALC_RCT` needs the bias on a grid: add `GRID_MIN` and `GRID_MAX`.');
      }
      const wn = numberOf(keywordValue(a, 'WALKERS_N'));
      const wid = numberOf(keywordValue(a, 'WALKERS_ID'));
      if (wn !== null && wid !== null && wid >= wn) {
        add('error', a.line, `\`WALKERS_ID=${wid}\` must be below \`WALKERS_N=${wn}\`: walkers count from 0.`);
      }
      if (hasFlag(a, 'WALKERS_MPI') && keywordValue(a, 'WALKERS_N')) {
        add('error', a.line, '`WALKERS_MPI` and `WALKERS_N` are two ways of sharing a bias. Keep one.');
      }
    }
    if (a.action === 'PRINT' || a.action === 'DUMPATOMS') {
      const stride = keywordValue(a, 'STRIDE');
      if (!stride) {
        add('note', a.line,
          `\`${a.action}\` has no \`STRIDE\`, so it writes at every step. That makes a large ` +
          'file and slows the run; a stride of a few hundred steps is usual.');
      }
      if (!keywordValue(a, 'FILE') && a.action === 'PRINT') {
        add('note', a.line, '`PRINT` has no `FILE`, so the values go to the PLUMED log.');
      }
    }
    if (a.action === 'COMBINE' || a.action === 'CUSTOM' || a.action === 'MATHEVAL') {
      if (!keywordValue(a, 'PERIODIC')) {
        add('error', a.line,
          `\`${a.action}\` needs \`PERIODIC\`: \`PERIODIC=NO\`, or the two ends of the period.`);
      }
    }
    if (a.action === 'MATHEVAL' && syntax && !syntax.has('MATHEVAL')) {
      add('error', a.line, '`MATHEVAL` was removed; write `CUSTOM` with the same keywords.');
    }

    if (a.label) {
      if (!seenAt.has(a.label)) seenAt.set(a.label, a.line);
      labels.add(a.label);
    }
  }

  for (const [name, m] of modules) {
    add('note', m.line,
      `${m.actions.map(x => `\`${x}\``).join(', ')} need${m.actions.length === 1 ? 's' : ''} the ` +
      `**${name}** module, which a default PLUMED ${syntax.version} build leaves out. Check with ` +
      `\`plumed config has module ${name}\`.`);
  }

  /* --- the file as a whole --- */
  const restart = actions.find(a => a.action === 'RESTART');
  if (restart && !hasFlag(restart, 'NO') && keywordValue(restart, 'NO') === '') {
    add('note', restart.line,
      '`RESTART` makes PLUMED append to its output files and read the hills already ' +
      'deposited. Use it only for the continuation of a run.');
  }
  const biases = actions.filter(a => METAD_FAMILY.has(a.action));
  const files = new Map();
  for (const a of actions) {
    if (!['PRINT', 'METAD', 'OPES_METAD', 'DUMPATOMS', 'DUMPGRID'].includes(a.action)) continue;
    const f = keywordValue(a, 'FILE') || (a.action === 'METAD' ? 'HILLS' : a.action === 'OPES_METAD' ? 'KERNELS' : '');
    if (!f) continue;
    if (files.has(f)) {
      add('warning', a.line,
        `\`${a.action}\` writes to \`${f}\`, which line ${files.get(f)} already writes to. ` +
        'The two outputs end up interleaved in one file; give each its own.');
    } else {
      files.set(f, a.line);
    }
  }
  if (biases.length && !actions.some(a => a.action === 'PRINT')) {
    add('note', biases[0].line,
      'The input biases the run but prints nothing. Add a `PRINT` of the biased variables ' +
      'and the bias: without it the free energy cannot be reweighted or checked.');
  }

  issues.sort((x, y) => x.line - y.line || rank(x.level) - rank(y.level));
  const count = (l) => issues.filter(x => x.level === l).length;
  return {
    issues,
    parsed,
    summary: {
      actions: actions.length, errors: count('error'), warnings: count('warning'), notes: count('note')
    }
  };
}

function rank(level) {
  return { error: 0, warning: 1, note: 2 }[level];
}

function numberOf(value) {
  const t = str(value).toLowerCase();
  if (!t) return null;
  const m = /^([+-]?)(\d*\.?\d*)\*?pi$/.exec(t);
  if (m) return (m[1] === '-' ? -1 : 1) * (m[2] === '' ? 1 : Number(m[2])) * Math.PI;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Edit distance between two words, for "did you mean".
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
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

function nearest(word, candidates) {
  let best = '';
  let score = Infinity;
  for (const c of candidates) {
    const d = editDistance(word, c);
    if (d < score) { score = d; best = c; }
  }
  return score <= Math.max(1, Math.floor(String(word).length / 4)) ? best : '';
}

function nearestAction(name, syntax) {
  return nearest(name, syntax.actionNames());
}

function nearestKeyword(name, keys) {
  return nearest(String(name).replace(/\d+$/, ''), keys);
}

/* ------------------------------------------------------------------ *
 * Explaining
 * ------------------------------------------------------------------ */

const PLAIN = {
  UNITS: 'Sets the units every number in the file is read in.',
  RESTART: 'Tells PLUMED this run continues an earlier one: outputs are appended to and earlier hills are read.',
  LOAD: 'Adds actions to PLUMED from a source file or a library.',
  INCLUDE: 'Reads another PLUMED file at this point, as if it were written here.',
  MOLINFO: 'Names the structure file that gives atoms their residue and chain, so that @ selections work.',
  WHOLEMOLECULES: 'Puts molecules broken by the periodic box back together before the variables are computed.',
  GROUP: 'Names a list of atoms so that later lines can use it.',
  CENTER: 'Defines a virtual atom at the centre of a group.',
  COM: 'Defines a virtual atom at the centre of mass of a group.',
  PRINT: 'Writes the listed values to a file as the run goes.',
  FLUSH: 'Makes PLUMED write its output files to disk regularly.',
  METAD: 'Metadynamics: adds Gaussian hills where the run has been, pushing it over barriers.',
  PBMETAD: 'Parallel-bias metadynamics: one one-dimensional bias per variable, all acting at once.',
  OPES_METAD: 'OPES: builds the bias from an estimate of the probability the run has sampled.',
  RESTRAINT: 'A harmonic spring that holds a value near a chosen point.',
  MOVINGRESTRAINT: 'A harmonic spring whose centre moves during the run, pulling the system along.',
  UPPER_WALLS: 'A wall that pushes back when a value rises above a limit.',
  LOWER_WALLS: 'A wall that pushes back when a value falls below a limit.',
  COMBINE: 'A weighted sum of other values.',
  CUSTOM: 'A value computed from others by a formula.',
  MATHEVAL: 'A value computed from others by a formula (the older name of CUSTOM).',
  ENDPLUMED: 'Ends the input: PLUMED ignores everything after it.'
};

/**
 * Explain an input action by action, in plain words.
 *
 * @param {string} text
 * @param {{syntax?:object}} [options]
 * @returns {Array<{line:number, endLine:number, label:string, action:string,
 *   summary:string, outputs:string, keywords:Array<{key:string, value:string|null,
 *   meaning:string}>, link:string}>}
 */
export function explainPlumedInput(text, options = {}) {
  const { syntax = null } = options;
  const { actions } = parsePlumedInput(text);
  const used = new Map();
  for (const a of actions) {
    for (const k of a.keywords) {
      if (k.value === null || !/^ARG/.test(k.key)) continue;
      for (const ref of listOf(k.value)) {
        const who = a.label || a.action;
        if (!used.has(ref)) used.set(ref, []);
        if (!used.get(ref).includes(who)) used.get(ref).push(who);
      }
    }
  }
  return actions.filter(a => a.action).map((a) => {
    const info = syntax && syntax.has(a.action) ? syntax.action(a.action) : null;
    let summary = PLAIN[a.action] || (info ? sentence(info.description) : '');
    if (!summary) {
      summary = 'Not an action of this PLUMED version; it may come from a LOAD file.';
    }
    const keywords = a.keywords.map((k) => {
      const kw = info ? syntax.keyword(a.action, k.key) : null;
      return { key: k.key, value: k.value, meaning: kw ? sentence(kw.description) : '' };
    });
    let outputs = '';
    if (a.label) {
      const refs = [...used.keys()].filter(r => r === a.label || r.startsWith(`${a.label}.`) ||
        r.startsWith(`${a.label}_`));
      if (refs.length) {
        const by = new Set();
        refs.forEach(r => used.get(r).forEach(x => by.add(x)));
        outputs = `Used as ${refs.map(r => `\`${r}\``).join(', ')} by ${[...by].map(x => `\`${x}\``).join(', ')}.`;
      } else if (!['GROUP', 'CENTER', 'COM'].includes(a.action)) {
        outputs = `Called \`${a.label}\`; nothing later in the file uses it.`;
      }
    }
    return {
      line: a.line, endLine: a.endLine, label: a.label, action: a.action, summary, outputs, keywords,
      link: syntax && syntax.has(a.action) ? syntax.docUrl(a.action) : ''
    };
  });
}

function sentence(text) {
  const s = str(text);
  if (!s) return '';
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/* ------------------------------------------------------------------ *
 * From a file to the builder
 * ------------------------------------------------------------------ */

const BIAS_METHOD = {
  PBMETAD: 'pbmetad', OPES_METAD: 'opes', RESTRAINT: 'restraint', MOVINGRESTRAINT: 'moving',
  UPPER_WALLS: 'upper', LOWER_WALLS: 'lower', ABMD: 'abmd'
};

/* The catalogue entry that writes an action, preferring the one with the
   most fields. */
function entryFor(action) {
  let best = null;
  for (const [type, def] of Object.entries(CV_DEFS)) {
    if (def.isCustom) continue;
    const variant = (def.fields || []).find(f => f.variant);
    const names = variant ? variant.options : [def.act || type];
    if (!names.includes(action)) continue;
    if (!best || (def.fields || []).length > (CV_DEFS[best].fields || []).length) best = type;
  }
  return best;
}

function rawLine(a) {
  const words = a.keywords.map((k) => {
    if (k.value === null) return k.key;
    return k.braced ? `${k.key}={${k.value}}` : `${k.key}=${k.value}`;
  });
  return [a.action, ...words].join(' ');
}

/* Fill a catalogue entry from the keywords of an action, or report that the
   action says something the entry cannot hold. */
function fillEntry(type, a) {
  const def = CV_DEFS[type];
  const values = {};
  const fields = def.fields || [];
  const byKey = new Map(fields.map(f => [f.k, f]));
  const folds = def.switchSpeed || def.coordSwitch;
  const reductions = new Set(['MEAN', 'SUM', 'MIN', 'ALT_MIN', 'MAX', 'HIGHEST', 'LOWEST',
    'MORE_THAN', 'LESS_THAN', 'BETWEEN']);
  const allowed = def.compStyle && def.compStyle !== 'none'
    ? (Array.isArray(def.reductions) ? new Set(def.reductions) : reductions)
    : new Set();
  for (const f of fields) values[f.k] = f.type === 'flag' ? false : '';
  const variant = fields.find(f => f.variant);
  if (variant) values[variant.k] = a.action;
  const numbered = {};
  const fragments = {};

  for (const k of a.keywords) {
    const f = byKey.get(k.key);
    const text = k.value === null ? null : (k.braced ? `{${k.value}}` : k.value);
    if (f && !f.variant) {
      if (f.type === 'flag') {
        if (k.value !== null) return null;
        values[k.key] = true;
      } else {
        if (k.value === null) return null;
        values[k.key] = text;
      }
      continue;
    }
    if (folds && k.key === 'SWITCH' && k.braced) {
      const parts = splitWords(k.value).words;
      if ((parts[0] || '').toUpperCase() !== 'RATIONAL') return null;
      for (const p of parts.slice(1).map(splitKeyword)) {
        if (!byKey.has(p.key) || p.value === null) return null;
        values[p.key] = p.value;
      }
      continue;
    }
    const base = k.key.replace(/\d+$/, '');
    if (allowed.has(k.key) || (allowed.has(base) && /\d+$/.test(k.key))) {
      if (k.value === null) values[k.key] = true;
      else if (base !== k.key) (numbered[base] = numbered[base] || []).push(text);
      else values[k.key] = text;
      continue;
    }
    // A field holding numbered keywords as one fragment: ATOMS1=.. ATOMS2=..
    const holder = fields.find(x => x.type === 'text' && /\w+\d+=/.test(String(x.def)) &&
      new RegExp(`\\b${base}\\d+=`).test(String(x.def)));
    const home = holder || (byKey.has(base) && /\d+$/.test(k.key) ? byKey.get(base) : null);
    if (home && text !== null) {
      (fragments[home.k] = fragments[home.k] || []).push(`${k.key}=${text}`);
      continue;
    }
    return null;
  }
  for (const [key, list] of Object.entries(numbered)) values[key] = list.join('; ');
  for (const [key, list] of Object.entries(fragments)) values[key] = list.join(' ');
  return values;
}

/**
 * Turn a PLUMED input into a description `generatePlumedInput` accepts, so
 * that an existing file can be edited in the builder.
 *
 * An action the catalogue covers becomes that entry; any other is kept word
 * for word as a custom line, with the components other lines use from it. What
 * cannot be carried over at all is listed in `notes`.
 *
 * @param {string} text
 * @returns {{config:object, notes:string[], fields:object}} `fields` holds the
 *          values of the page's fixed form fields.
 */
export function importPlumedInput(text) {
  const { actions, errors } = parsePlumedInput(text);
  const notes = errors.map(e => `Line ${e.line}: ${e.text}`);
  const config = {
    units: { length: 'nm', energy: 'kj/mol', time: 'ps' },
    preamble: { restart: false, load: [], include: [], flush: '' },
    molinfo: { structure: '' },
    whole: { enabled: false, residues: false, entities: '' },
    cvs: [],
    functions: [],
    restraints: [],
    bias: { method: 'none', params: {}, temp: '', stride: '', grid: false, rct: false, walkers: { mode: 'none' } },
    prints: []
  };
  let seq = 0;
  let fnSeq = 0;
  let resSeq = 0;
  let biasAction = null;

  /* Components other actions refer to, by label. */
  const labels = new Set(actions.map(a => a.label).filter(Boolean));
  const usedComponents = new Map();
  for (const a of actions) {
    for (const k of a.keywords) {
      if (k.value === null || k.braced || !/^ARG/.test(k.key)) continue;
      for (const ref of listOf(k.value)) {
        const owner = resolveReference(ref, labels);
        if (!owner || owner === ref) continue;
        if (!usedComponents.has(owner)) usedComponents.set(owner, []);
        const suffix = ref.slice(owner.length);
        if (!usedComponents.get(owner).includes(suffix)) usedComponents.get(owner).push(suffix);
      }
    }
  }

  const custom = (a) => {
    const comps = (usedComponents.get(a.label) || []).filter(c => !/[*?]/.test(c));
    return {
      id: `cv${++seq}`, type: 'CUSTOM', label: a.label || `a${seq}`, bias: false,
      isGroup: false, noBias: false,
      values: { __raw: rawLine(a), __components: comps.map(c => c.replace(/^\./, '')).join(',') },
      biasValues: defaultBiasValues('CUSTOM'),
      unlabelled: !a.label
    };
  };

  for (const a of actions) {
    if (!a.action) continue;
    const v = (k) => keywordValue(a, k);
    switch (a.action) {
      case 'UNITS':
        if (v('LENGTH')) config.units.length = v('LENGTH');
        if (v('ENERGY')) config.units.energy = v('ENERGY');
        if (v('TIME')) config.units.time = v('TIME');
        continue;
      case 'RESTART':
        config.preamble.restart = !hasFlag(a, 'NO');
        continue;
      case 'LOAD':
        if (v('FILE')) config.preamble.load.push(v('FILE'));
        continue;
      case 'INCLUDE':
        if (v('FILE')) config.preamble.include.push(v('FILE'));
        continue;
      case 'FLUSH':
        config.preamble.flush = v('STRIDE');
        continue;
      case 'MOLINFO':
        config.molinfo.structure = v('STRUCTURE');
        if (v('MOLTYPE')) config.molinfo.moltype = v('MOLTYPE');
        continue;
      case 'WHOLEMOLECULES': {
        config.whole.enabled = true;
        const ents = a.keywords.filter(k => /^ENTITY\d+$/.test(k.key)).map(k => k.value);
        if (ents.length) config.whole.entities = ents.join('\n');
        else config.whole.residues = true;
        continue;
      }
      case 'PRINT': {
        const args = listOf(v('ARG'));
        config.prints.push({
          file: v('FILE') || 'COLVAR', stride: v('STRIDE'), extra: '', all: false, args, only: true
        });
        continue;
      }
      case 'COMBINE':
      case 'CUSTOM':
      case 'MATHEVAL': {
        const type = a.action === 'COMBINE' ? 'COMBINE' : 'CUSTOM';
        const values = {};
        for (const f of FUNCTION_DEFS[type].fields) values[f.k] = f.type === 'flag' ? false : '';
        let ok = true;
        for (const k of a.keywords) {
          if (k.key === 'ARG') continue;
          if (!(k.key in values)) { ok = false; break; }
          values[k.key] = k.value === null ? true : k.value;
        }
        if (!ok || !a.label) { config.cvs.push(custom(a)); continue; }
        config.functions.push({
          id: `fn${++fnSeq}`, type, label: a.label, args: listOf(v('ARG')), values, bias: false,
          biasValues: { comp: '', min: '-5.0', max: '5.0', bin: '200', sigma: '0.1' }
        });
        continue;
      }
      default:
        break;
    }

    const method = a.action === 'METAD'
      ? (v('BIASFACTOR') ? 'wt_metad' : 'metad')
      : BIAS_METHOD[a.action];
    if (method) {
      const args = listOf(v('ARG'));
      const wall = ['upper', 'lower', 'restraint'].includes(method);
      if (biasAction && wall) {
        // A second bias: walls and restraints stand beside the first.
        args.forEach((arg, j) => {
          const at = (k) => { const l = listOf(v(k)); return l.length === 1 ? l[0] : (l[j] || ''); };
          config.restraints.push({
            id: `res${++resSeq}`, type: method, arg,
            label: args.length === 1 && a.label ? a.label : `${a.label || method}${args.length > 1 ? `_${j + 1}` : ''}`,
            at: at('AT'), kappa: at('KAPPA'), exp: at('EXP'), eps: at('EPS'), offset: at('OFFSET')
          });
        });
        if (args.length > 1 && a.label) {
          notes.push(
            `Line ${a.line}: \`${a.label}\` acts on ${args.length} values and was split into one ` +
            'wall per value, so its label changed. Update anything that refers to it.');
        }
        continue;
      }
      if (biasAction) {
        notes.push(
          `Line ${a.line}: a second \`${a.action}\` was kept as a custom line. The builder edits ` +
          'one sampling method at a time.');
        config.cvs.push(custom(a));
        continue;
      }
      biasAction = a;
      config.bias.method = method;
      config.bias.label = a.label || '';
      config.bias.args = args;
      const known = new Set((BIAS_DEFS[method].params || []).map(p => p.k));
      const handled = new Set(['ARG', 'SIGMA', 'GRID_MIN', 'GRID_MAX', 'GRID_BIN', 'FILE', 'CALC_RCT',
        'RCT_USTRIDE', 'WALKERS_MPI', 'WALKERS_N', 'WALKERS_ID', 'WALKERS_DIR', 'WALKERS_RSTRIDE',
        'STATE_WFILE', 'STATE_WSTRIDE', 'NLIST']);
      const extra = [];
      for (const k of a.keywords) {
        if (known.has(k.key) && k.value !== null) config.bias.params[k.key] = k.value;
        else if (!handled.has(k.key)) extra.push(k.value === null ? k.key : `${k.key}=${k.value}`);
      }
      if (v('SIGMA') && method === 'opes') config.bias.params.SIGMA = v('SIGMA');
      if (v('TEMP')) config.bias.temp = v('TEMP');
      if (v('PACE')) config.bias.stride = v('PACE');
      config.bias.grid = !!v('GRID_MIN');
      config.bias.rct = hasFlag(a, 'CALC_RCT');
      if (hasFlag(a, 'WALKERS_MPI')) config.bias.walkers = { mode: 'mpi' };
      else if (v('WALKERS_N')) {
        config.bias.walkers = {
          mode: 'disk', n: v('WALKERS_N'), id: v('WALKERS_ID'), dir: v('WALKERS_DIR'),
          rstride: v('WALKERS_RSTRIDE')
        };
      }
      config.bias.targets = args.map((arg, j) => ({
        arg,
        min: listOf(v('GRID_MIN'))[j] || '',
        max: listOf(v('GRID_MAX'))[j] || '',
        bin: listOf(v('GRID_BIN'))[j] || '',
        sigma: listOf(v('SIGMA'))[j] || ''
      }));
      if (extra.length) {
        notes.push(
          `Line ${a.line}: \`${a.action}\` has keywords the builder does not edit ` +
          `(${extra.map(x => `\`${x}\``).join(', ')}). Add them by hand to the file it writes.`);
      }
      continue;
    }

    const type = a.label ? entryFor(a.action) : null;
    const values = type ? fillEntry(type, a) : null;
    if (!type || !values) {
      config.cvs.push(custom(a));
      continue;
    }
    const def = CV_DEFS[type];
    config.cvs.push({
      id: `cv${++seq}`, type, label: a.label, bias: false, isGroup: !!def.isGroup,
      noBias: !!def.noBias, values, biasValues: defaultBiasValues(type)
    });
  }

  /* --- mark what the bias acts on, with its grid --- */
  for (const t of config.bias.targets || []) {
    const fn = config.functions.find(f => f.label === t.arg);
    const owner = fn ? null : resolveReference(t.arg, new Set(config.cvs.map(c => c.label)));
    const cv = owner ? config.cvs.find(c => c.label === owner) : null;
    const target = fn || cv;
    if (!target) {
      notes.push(`The bias acts on \`${t.arg}\`, which the file does not define.`);
      continue;
    }
    target.bias = true;
    const comp = cv ? t.arg.slice(owner.length) : '';
    target.biasValues = {
      ...target.biasValues, comp,
      ...(t.min ? { min: t.min } : {}), ...(t.max ? { max: t.max } : {}),
      ...(t.bin ? { bin: t.bin } : {}), ...(t.sigma ? { sigma: t.sigma } : {})
    };
  }
  delete config.bias.targets;
  delete config.bias.args;

  const unlabelled = config.cvs.filter(c => c.unlabelled);
  for (const c of unlabelled) {
    notes.push(
      `\`${c.values.__raw.split(' ')[0]}\` had no label and was given \`${c.label}\`, since the ` +
      'builder labels every line.');
    delete c.unlabelled;
  }
  if (!config.prints.length) config.prints.push({ file: 'COLVAR', stride: '', extra: '', all: true, args: [] });

  /* An output that lists everything is kept as "everything", so that a
     variable added later is printed too. */
  const fields = {
    plumedUnitLength: config.units.length, plumedUnitEnergy: config.units.energy,
    plumedUnitTime: config.units.time, plumedMolinfo: config.molinfo.structure,
    plumedWhole: config.whole.enabled, plumedWholeResidues: config.whole.residues,
    plumedWholeEntities: config.whole.entities, plumedRestart: config.preamble.restart,
    plumedLoad: config.preamble.load.join('\n'), plumedInclude: config.preamble.include.join('\n'),
    plumedFlush: config.preamble.flush, plumedBias: config.bias.method,
    plumedTemp: config.bias.temp, plumedStride: config.bias.stride || '500',
    plumedGrid: config.bias.grid, plumedRct: config.bias.rct,
    plumedWalkersMode: config.bias.walkers.mode,
    plumedWalkersN: config.bias.walkers.n || '4', plumedWalkersId: config.bias.walkers.id || '0',
    plumedWalkersDir: config.bias.walkers.dir || '../hills',
    plumedWalkersRstride: config.bias.walkers.rstride || '100'
  };
  return { config, notes, fields };
}
