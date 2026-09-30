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
 *     only inside a block may a `{` stay open over several lines;
 *   - words are separated by spaces and tabs, and nothing else (a no-break
 *     space pasted from a web page joins two words), except inside `{ }`,
 *     which may nest;
 *   - an action is labelled `label: ACTION ...` or `ACTION LABEL=label ...`;
 *   - `KEY=value` matches its keyword in either case, but a flag must be
 *     written exactly as registered (`NOPBC`, `logActivity`), and so must an
 *     action written alone on a line (`RESTART`, not `restart`);
 *   - `ENDPLUMED` ends the input, whatever follows it.
 *
 * The checks that need to know the language, which keywords an action has and
 * which module it lives in, take a table from `plumed-syntax.js`. They were
 * tuned on the input files of the regression tests of PLUMED 2.9, 2.10 and
 * 2.11, which those releases run, so an error about one of them is a false
 * alarm; and on the same files with one mistake put in, which PLUMED stops at.
 * An error is something PLUMED stops at; a warning is something it runs but
 * that is probably not meant.
 */

import { CV_DEFS, FUNCTION_DEFS, BIAS_DEFS } from './plumed-catalogue.js';
import {
  parseAtomList, defaultBiasValues, LENGTH_IN_NM, versionAtLeast, biasLabelFor
} from './plumed.js';

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

/* PLUMED separates words by spaces, tabs and line ends only (Tools::getWords). */
const BLANK = /[ \t\n]/;
const trimBlanks = (t) => String(t).replace(/^[ \t]+|[ \t]+$/g, '');
const blankWords = (t) => trimBlanks(t).split(/[ \t]+/).filter(Boolean);

/**
 * Split a line into words, keeping a `{ ... }` group together. Only spaces
 * and tabs separate words, as in PLUMED.
 *
 * @param {string} text
 * @returns {{words:string[], unbalanced:boolean, extraClose:boolean}}
 *   `unbalanced` is set by either mistake; `extraClose` only by a `}` that
 *   closes no `{`, which PLUMED reports first ("Extra closed parenthesis").
 */
export function splitWords(text) {
  const words = [];
  let cur = '';
  let depth = 0;
  let unbalanced = false;
  let extraClose = false;
  for (const ch of String(text == null ? '' : text)) {
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth < 0) { unbalanced = true; extraClose = true; depth = 0; }
    }
    if (depth === 0 && BLANK.test(ch)) {
      if (cur) { words.push(cur); cur = ''; }
    } else {
      cur += BLANK.test(ch) ? ' ' : ch;
    }
  }
  if (cur) words.push(cur);
  if (depth !== 0) unbalanced = true;
  return { words, unbalanced, extraClose };
}

/* Whitespace PLUMED does not take for a separator, with a name to report. */
const ODD_SPACE = /[^\S \t\n]/;
function oddSpaceName(ch) {
  const names = { '\u00a0': 'a no-break space', '\u202f': 'a narrow no-break space', '\u2009': 'a thin space',
    '\u3000': 'an ideographic space', '\v': 'a vertical tab', '\f': 'a form feed', '\ufeff': 'a byte-order mark' };
  const code = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  return `${names[ch] || 'an unusual space'} (U+${code})`;
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
 * @property {Array<{key:string, value:string|null, braced:boolean}>} keywords -
 *           A `KEY=value` key is in capitals, since PLUMED matches it in
 *           either case; a flag keeps the case it was written in.
 * @property {boolean} block - Written over several lines with `...`.
 * @property {string[]} comments - Comments directly above the action.
 */

/**
 * Parse a PLUMED input.
 *
 * @param {string} text
 * @returns {{actions:ParsedAction[], errors:Array<{line:number, text:string,
 *   level?:'warning'}>, ended:number|null}} `ended` is the line of
 *   `ENDPLUMED`, if there is one. An entry of `errors` with `level: 'warning'`
 *   is something PLUMED accepts but that is probably not meant.
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
  const reportOddSpace = (code, lineNo) => {
    const m = ODD_SPACE.exec(code);
    if (!m) return;
    errors.push({
      line: lineNo,
      text: `The line holds ${oddSpaceName(m[0])}. PLUMED separates words only by spaces and ` +
        'tabs, so the words on either side read as one; retype it as a plain space.'
    });
  };

  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const { code, comment } = stripComment(lines[i]);
    i += 1;
    reportOddSpace(code, lineNo);

    if (!trimBlanks(code)) {
      if (comment) comments.push(comment);
      else comments = [];
      continue;
    }
    const lineWords = blankWords(code);
    const firstWord = lineWords[0];
    if (firstWord === 'ENDPLUMED') {
      ended = lineNo;
      break;
    }
    if (firstWord === '...' && lineWords.length > 1) {
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
    let openBrace = false;

    // `METAD...`, with no space before the dots: PLUMED opens a block only
    // when a line ends with `...` as a word of its own, and otherwise stops
    // at an action named `METAD...`. The line is read as the block it was
    // meant to open, so the lines after it are not reported one by one.
    const at = firstWord.length > 1 && firstWord.endsWith(':') ? 1 : 0;
    const glued = /^[A-Za-z][A-Za-z0-9_]*\.\.\.$/.test(lineWords[at] || '') ? lineWords[at] : '';
    if (glued) {
      const rest = lineWords.slice(at + 1);
      if (rest[rest.length - 1] === '...') rest.pop();
      const fixed = [...lineWords.slice(0, at), glued.slice(0, -3), ...rest, '...'];
      errors.push({
        line: lineNo,
        text: `\`${glued}\` needs a space before the dots: write \`${fixed.join(' ')}\`. PLUMED ` +
          'opens a block only when a line ends with `...` as a word of its own; otherwise it ' +
          `stops at an action named \`${glued}\`.`
      });
      lineWords.splice(0, lineWords.length, ...fixed);
    }

    if (lineWords[lineWords.length - 1] === '...') {
      block = true;
      body = lineWords.slice(0, -1).join(' ');
      if (!body) {
        errors.push({
          level: 'warning', line: lineNo,
          text: 'A line holding only `...` opens a block: PLUMED joins the lines after it into ' +
            'one action, up to the next `...`. Start the block on the line of its action.'
        });
      }
      let closed = false;
      while (i < lines.length) {
        const n = i + 1;
        const part = stripComment(lines[i]).code;
        i += 1;
        reportOddSpace(part, n);
        const words = blankWords(part);
        if (words[0] === '...') {
          closed = true;
          endLine = n;
          const rest = words.slice(1);
          const first = blankWords(body)[0] || '';
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
        // PLUMED drops a `...` at the end of a line inside a block.
        const kept = words[words.length - 1] === '...' ? words.slice(0, -1) : words;
        body += ` ${kept.join(' ')}`;
        if (words.length) endLine = n;
      }
      if (!closed) {
        errors.push({
          level: 'warning', line: lineNo,
          text: `The block opened with \`${blankWords(body)[0] || '...'}\` is never closed. PLUMED ` +
            'reads it to the end of the file as one action; end it with a line holding `...`.'
        });
      }
    } else if (depthOf(body) > 0) {
      // PLUMED stops at a brace left open outside a block. The lines up to
      // the one that closes it are read with it, so that one mistake is
      // reported once and not again on every line it swallowed.
      const opened = lineNo;
      openBrace = true;
      while (depthOf(body) > 0 && i < lines.length) {
        body += ` ${stripComment(lines[i]).code}`;
        endLine = i + 1;
        i += 1;
      }
      errors.push({
        line: opened,
        text: 'A `{` opened on this line is not closed on it. PLUMED joins lines only inside a ' +
          '`...` block, so it stops here ("non matching parenthesis"). Close the brace on the ' +
          'same line, or write the action as a block.'
      });
    }

    const split = splitWords(body);
    let all = split.words;
    if (split.extraClose && !openBrace) {
      // PLUMED meets the stray `}` before anything else on the line.
      errors.push({
        line: lineNo,
        text: `Unbalanced braces: a \`}\`${block ? '' : ' on this line'} closes no \`{\`. ` +
          'PLUMED stops here ("Extra closed parenthesis").'
      });
      all = all.filter(w => !/^}+$/.test(w));
    } else if (split.unbalanced && !openBrace) {
      errors.push({
        line: lineNo,
        text: block
          ? 'Unbalanced braces: a `{` has no matching `}`.'
          : 'Unbalanced braces: a `{` has no matching `}` on this line. PLUMED stops ' +
            '("non matching parenthesis"): a brace may continue onto the next lines only ' +
            'inside a `...` block.'
      });
    }
    if (!all.length) {
      comments = [];
      continue;
    }

    // PLUMED capitalises the action name only when the line holds more than
    // one word (Tools::interpretLabel): `restart` alone stays `restart`.
    const words = all.length;
    let label = '';
    if (all.length && all[0].endsWith(':') && all[0].length > 1) {
      label = all[0].slice(0, -1);
      all = all.slice(1);
    }
    // `d:DISTANCE`, with no space after the colon, is one word to PLUMED,
    // which stops at an action it does not know (`D:DISTANCE`). It is read
    // as meant, so the label is still defined for the lines that use it.
    const glue = !label && /^([^\s:{}=]+):([A-Za-z][A-Za-z0-9_]*)$/.exec(all[0] || '');
    if (glue) {
      errors.push({
        line: lineNo,
        text: `\`${all[0]}\` needs a space after the colon: write \`${glue[1]}: ${glue[2]}\`. ` +
          `PLUMED reads \`${all[0]}\` as one word, the name of an action it does not know.`
      });
      label = glue[1];
      all = [glue[2], ...all.slice(1)];
    }
    const written = all[0] || '';
    const action = words > 1 && /^[A-Za-z][A-Za-z0-9_]*$/.test(written) ? written.toUpperCase() : written;
    // A key is matched in either case, a flag exactly as written.
    const keywords = all.slice(1).map(splitKeyword)
      .map(k => (k.value === null ? k : { ...k, key: k.key.toUpperCase() }));

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
      const upper = written.toUpperCase();
      errors.push({
        line: lineNo,
        text: words === 1 && ACTION_RE.test(upper)
          ? `\`${written}\` alone on a line is read exactly as written, and PLUMED names its ` +
            `actions in capitals: write \`${upper}\`.`
          : `\`${action}\` cannot be an action name: PLUMED actions are written in capitals.`
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
 * Only a shortcut names the actions it creates after its own label
 * (`cn_mean`, `pamm-1_mean`); `phi_1` is no value of a TORSION `phi`, and
 * PLUMED stops at it. `options.prefixed` says which labels may be followed
 * by such a suffix; without it every label may, as the parser alone cannot
 * tell.
 *
 * @param {string} ref
 * @param {Set<string>} labels
 * @param {{prefixed?:(label:string)=>boolean}} [options]
 * @returns {string|null} Null when nothing defined matches.
 */
export function resolveReference(ref, labels, options = {}) {
  const r = str(ref);
  if (!r) return null;
  if (labels.has(r)) return r;
  const dot = r.indexOf('.');
  if (dot > 0 && labels.has(r.slice(0, dot))) return r.slice(0, dot);
  const may = typeof options.prefixed === 'function' ? options.prefixed : () => true;
  let best = null;
  for (const l of labels) {
    if (r.length > l.length && r.startsWith(l) && /[_\-.\d]/.test(r[l.length]) && may(l) &&
      (!best || l.length > best.length)) best = l;
  }
  return best;
}

/* A number, an @replicas list, or a regular expression, none of them a label. */
function isLiteralReference(ref) {
  const r = str(ref);
  return /[()]/.test(r) || r.startsWith('@') || /^[-+]?(\d|\.\d)/.test(r);
}

/* A wildcard: `*`, `*.bias`, `m.*`. Only the label before the dot, when it
   holds no wildcard itself, has to exist. */
function wildcardLabel(ref) {
  const r = str(ref);
  if (!/[*?]/.test(r)) return null;
  const dot = r.indexOf('.');
  if (dot < 1) return '';
  const head = r.slice(0, dot);
  return /[*?]/.test(head) ? '' : head;
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

/* Setup actions must come before every other action; the ones PLUMED lets
   stand anywhere may come before them too. LOAD was a setup action in 2.9
   and may stand anywhere from 2.10 (core/ActionSetup.cpp, ActionAnyorder). */
function orderRules(version) {
  const old = version === '2.9';
  return {
    setup: new Set(old ? ['RESTART', 'UNITS', 'LOAD'] : ['RESTART', 'UNITS']),
    any: new Set(old ? ['MOLINFO', 'INCLUDE'] : ['MOLINFO', 'INCLUDE', 'LOAD'])
  };
}
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

/* Keywords whose words are atoms or the labels of groups and centres. */
const ATOM_KEYS = /^(ATOMS?|GROUP[ABC]?|SPECIES[AB]?|ENTITY|CENTER|ORIGIN|AXIS_ATOMS|VECTORSTART|VECTOREND|CATOMS)\d*$/;
/* Keywords that name other actions by their label. */
const LABEL_KEYS = /^(SPECIES|SPECIESA|SPECIESB)$/;
/* @ words PLUMED resolves without MOLINFO (core/ActionAtomistic.cpp). */
const NO_MOLINFO = /^@(allatoms|mdatoms|ndx:)/;

/* Switching functions as PLUMED reads them (tools/SwitchingFunction.cpp):
   the type is matched exactly, R_0 is needed by every type but CUBIC, and a
   word left over stops the run. */
const SWITCH_TYPES = {
  RATIONAL: ['NN', 'MM'], SMAP: ['A', 'B'], Q: ['BETA', 'LAMBDA', 'REF'], EXP: [], GAUSSIAN: [],
  TANH: [], COSINUS: [], CUBIC: [], CUSTOM: ['FUNC'], MATHEVAL: ['FUNC']
};
const SWITCH_COMMON = ['D_0', 'D_MAX', 'R_0'];
const SWITCH_FLAGS = ['STRETCH', 'NOSTRETCH'];
/* Keywords that hold a switching function. */
const SWITCH_KEYS = /^(SWITCH\d*|SWITCH[AB]|SWITCH_COORD|[HA]SWITCH|MORE_THAN\d*|LESS_THAN\d*)$/;
/* Keywords whose switching function acts on a distance. MORE_THAN and
   LESS_THAN, and the SWITCH of the function actions of that name, act on a
   value such as a coordination number. */
const DISTANCE_SWITCH = /^(SWITCH|SWITCH\d+|SWITCHA|SWITCHB|R_0|D_0|D_MAX)$/;
const VALUE_SWITCH_ACTIONS = new Set(['MORE_THAN', 'LESS_THAN', 'BETWEEN']);

/* Actions whose label names a single virtual atom. */
const ONE_ATOM = new Set(['CENTER', 'COM', 'FIXEDATOM', 'CENTER_FAST', 'ARGS2VATOM']);
/* How many atoms an action takes in ATOMS, when fixed. */
const ATOM_COUNT = {
  DISTANCE: [2], TORSION: [4], ANGLE: [3, 4], DIHEDRAL_CORRELATION: [8], PLANE: [3, 4],
  PUCKERING: [5, 6]
};
/* Keywords that SWITCH={...} replaces when it is given: the parameters of a
   switching function (COORDINATION) or of a histogram bead (BETWEEN). */
const SWITCH_PARTS = new Set(['R_0', 'D_0', 'NN', 'MM', 'D_MAX', 'LOWER', 'UPPER', 'SMEAR']);
/* Compulsory keywords without a default that an action reads only in some
   modes, or fills in itself: KDE takes BANDWIDTH instead of METRIC, and
   REWEIGHT_BIAS reads every bias when ARG is left out. */
const OPTIONAL_IN_PRACTICE = {
  KDE: ['METRIC', 'CONCENTRATION'], SPHERICAL_KDE: ['METRIC'], SELECT_WITH_MASK: ['MASK'],
  ANN: ['PERIODIC'], REFERENCE_GRID: ['FILE', 'VALUE', 'PERIODIC'], REWEIGHT_BIAS: ['ARG'],
  REWEIGHT_METAD: ['ARG'], CREATE_MASK: ['NZEROS'], HISTOGRAM: ['BANDWIDTH', 'GRID_MIN', 'GRID_MAX']
};
/* Actions that ask for NL_CUTOFF and NL_STRIDE once NLIST is on
   (colvar/CoordinationBase.cpp). */
const NLIST_ACTIONS = new Set(['COORDINATION', 'DHENERGY', 'GHBFIX']);

/**
 * @typedef {object} Issue
 * @property {'error'|'warning'|'note'} level - An error stops PLUMED; a
 *           warning lets it run and may give a wrong result; a note is advice.
 * @property {number} line
 * @property {string} text
 */

/* Look a keyword up as PLUMED matches it: KEY=value in either case, a flag
   exactly. Returns the table's entry, or null. */
function lookupKeyword(syntax, action, k) {
  const exact = syntax.keyword(action, k.key);
  if (exact) return exact;
  if (k.value === null) return null;
  const upper = k.key.toUpperCase();
  const names = (syntax.action(action) || { keywords: [] }).keywords.map(x => x.name);
  const name = names.find(n => n.toUpperCase() === upper);
  if (name) return syntax.keyword(action, name);
  const m = /^(.*?)(\d+)$/.exec(k.key);
  if (m) {
    const base = names.find(n => n.toUpperCase() === m[1].toUpperCase());
    if (base) return syntax.keyword(action, `${base}${m[2]}`);
  }
  return null;
}

/* Does an action set a keyword, numbered instances included? */
function sets(a, name) {
  const up = String(name).toUpperCase();
  return a.keywords.some(k => k.key === name || (k.value !== null && k.key === up) ||
    new RegExp(`^${up.replace(/[^A-Z0-9_]/g, '')}\\d+$`).test(k.key.toUpperCase()));
}

/* Is a component name one the action lists? Numbered ones (`eig-0`,
   `morethan-2`) and those named after an argument (`d1_min`) count. */
function findOutput(outputs, comp) {
  const base = comp.replace(/-\d+$/, '');
  return outputs.find(o => o.name === comp) ||
    outputs.find(o => o.name === base) ||
    outputs.find(o => o.name.startsWith('_') && (o.name.slice(1) === comp ||
      (comp.length > o.name.length && comp.endsWith(o.name)))) || null;
}

/* Keywords that alone switch a component on. Others, such as
   CALC_TRANSITION_BIAS, are one of several ways to get theirs. */
const ENABLING = /^(COMPONENTS|SCALED_COMPONENTS|CALC_RCT|CALC_WORK|CALC_MAX_BIAS|ACCELERATION|MEAN|SUM|MIN|MAX|ALT_MIN|HIGHEST|LOWEST|MORE_THAN|LESS_THAN|BETWEEN|MOMENTS|VMEAN|VSUM)$/;

const needsCache = new WeakMap();
/* Does the table record what shortcuts expand into (2.10 on)? */
function tableHasNeeds(syntax) {
  if (!needsCache.has(syntax)) {
    needsCache.set(syntax, typeof syntax.needs === 'function' &&
      syntax.actionNames().some(n => syntax.needs(n).length > 0));
  }
  return needsCache.get(syntax);
}

/* May the actions of this action be named after its label with a suffix? */
function makesPrefixed(syntax, action) {
  if (!syntax || !syntax.has(action)) return true;
  if (typeof syntax.needs !== 'function') return true;
  if (syntax.needs(action).length) return true;
  return !tableHasNeeds(syntax) && syntax.isShortcut(action);
}

/**
 * What is wrong with a reference to `owner.comp`, or with the bare label
 * when `comp` is null, as far as the keyword table can tell.
 *
 * @returns {string|null}
 */
function componentProblem(owner, comp, syntax) {
  if (!syntax || !owner || !syntax.has(owner.action)) return null;
  const info = syntax.action(owner.action);
  const outs = info.outputs || [];
  if (!outs.length || outs.some(o => o.name.includes('#'))) return null;
  const shortcut = typeof syntax.needs === 'function' && syntax.needs(owner.action).length > 0;
  const flagSet = (o) => o.keyword && o.keyword !== 'value' && sets(owner, o.keyword);
  if (comp === null) {
    if (shortcut) return null;
    const hasValue = outs.some(o => o.name === 'value');
    const replacing = outs.filter(o => /COMPONENTS$/.test(o.keyword || '') && flagSet(o));
    if (replacing.length) {
      return `\`${owner.label}\` (${owner.action}) sets \`${replacing[0].keyword}\`, so it has ` +
        `components only: refer to \`${owner.label}.${replacing[0].name}\` and the like.`;
    }
    // Components named after an argument (PIECEWISE's `_pfunc`) replace the
    // value only for several arguments, so they prove nothing.
    const always = outs.filter(o => o.keyword === null && o.name !== 'value' && !o.name.startsWith('_'));
    // Only the 2.11 table lists `value` wherever there is one (2.10 leaves it
    // out for CONTACTMAP with SUM, for one).
    if (!hasValue && always.length && versionAtLeast(syntax.version, '2.11')) {
      return `\`${owner.label}\` (${owner.action}) has no value of its own, only components: ` +
        `${always.slice(0, 3).map(o => `\`${owner.label}.${o.name.replace(/^_/, '')}\``).join(', ')}` +
        `${always.length > 3 ? ', ...' : ''}.`;
    }
    return null;
  }
  if (/[*?]/.test(comp) || /^\d+$/.test(comp)) return null;
  const o = findOutput(outs, comp);
  if (!o) {
    // The 2.9 table does not mark the components an action names at run
    // time (READ, PROPERTYMAP, ECV_LINEAR), so a name it lacks proves nothing.
    if (shortcut || !versionAtLeast(syntax.version, '2.10')) return null;
    const names = outs.map(x => x.name).filter(n => n !== 'value' && !n.startsWith('_'));
    return `\`${owner.label}\` (${owner.action}) has no component \`${comp}\`` +
      (names.length ? `; it has ${names.slice(0, 6).map(n => `\`${n}\``).join(', ')}` +
        `${names.length > 6 ? ', ...' : ''}.` : '.');
  }
  if (o.keyword && ENABLING.test(o.keyword) && !sets(owner, o.keyword)) {
    return `\`${owner.label}.${comp}\` exists only when \`${owner.label}\` sets \`${o.keyword}\`.`;
  }
  return null;
}

/* The period of a value as PLUMED writes it, when the value is periodic. */
function periodOf(owner, comp) {
  if (!owner) return null;
  if (!comp) {
    if (owner.action === 'TORSION' && !hasFlag(owner, 'COSINE')) return ['-pi', 'pi'];
    const p = keywordValue(owner, 'PERIODIC');
    if (p && p.toUpperCase() !== 'NO') {
      const parts = p.split(',').map(str);
      if (parts.length === 2) return parts;
    }
    return null;
  }
  if (owner.action === 'PUCKERING') {
    if (comp === 'phs') return ['-pi', 'pi'];
    if (comp === 'phi') return ['0', '2pi'];
  }
  return null;
}

/* How many atoms an atom list names, or null when it holds something whose
   size only PLUMED knows (a group, an @ selection). */
function atomCount(value, defs) {
  const parsed = parseAtomList(value);
  if (parsed.errors.length) return null;
  let n = parsed.count;
  for (const l of parsed.labels) {
    const d = defs.get(l);
    if (!d || !ONE_ATOM.has(d.action)) return null;
    n += 1;
  }
  return n;
}

/* Check the contents of a switching function. Returns problems as text. */
function switchProblems(value, version) {
  const out = [];
  const words = splitWords(value).words;
  if (!words.length) return ['is empty.'];
  const type = words[0];
  if (!Object.prototype.hasOwnProperty.call(SWITCH_TYPES, type)) {
    const up = type.toUpperCase();
    out.push(Object.prototype.hasOwnProperty.call(SWITCH_TYPES, up)
      ? `names its type \`${type}\`; PLUMED reads the type exactly as written: \`${up}\`.`
      : `names the type \`${type}\`, which PLUMED does not know; it knows ` +
        `${Object.keys(SWITCH_TYPES).map(t => `\`${t}\``).join(', ')}.`);
    return out;
  }
  const allowed = new Set([...SWITCH_COMMON, ...SWITCH_TYPES[type]]);
  if (type === 'CUBIC') allowed.delete('R_0');
  const given = new Set();
  const rogue = [];
  for (const w of words.slice(1)) {
    const k = splitKeyword(w);
    if (k.value === null) {
      if (!SWITCH_FLAGS.includes(k.key)) rogue.push(w);
      continue;
    }
    const key = k.key.toUpperCase();
    if (!allowed.has(key)) rogue.push(w);
    else given.add(key);
  }
  if (rogue.length) {
    out.push(`holds ${rogue.map(w => `\`${w}\``).join(', ')}, which a ${type} switching ` +
      `function does not take; PLUMED stops at a word it has not read` +
      (type === 'CUBIC' && rogue.some(w => /^R_0=/i.test(w)) ? ' (CUBIC is set by D_0 and D_MAX alone).' : '.'));
  }
  if (type !== 'CUBIC' && !given.has('R_0')) out.push(`has no \`R_0\`, which ${type} needs.`);
  if (type === 'Q' && !given.has('REF')) out.push('has no `REF`, which Q needs.');
  if (type === 'SMAP' && version !== '2.9' && (!given.has('A') || !given.has('B'))) {
    out.push('needs both `A` and `B`.');
  }
  return out;
}

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
  const { setup, any } = orderRules(syntax ? syntax.version : '');

  const labels = new Set();
  const defs = new Map();
  const seenAt = new Map();
  let units = { length: 'nm' };
  let sawAction = false;
  const modules = new Map();
  const prefixed = (l) => makesPrefixed(syntax, (defs.get(l) || {}).action);
  const resolve = (ref) => resolveReference(ref, labels, { prefixed });

  for (const a of actions) {
    const s = syntax && syntax.has(a.action) ? syntax : null;

    /* --- order of setup actions --- */
    if (setup.has(a.action)) {
      if (sawAction) {
        add('error', a.line,
          `\`${a.action}\` is a setup action and must come before every other action ` +
          `(only ${[...any].map(x => `\`${x}\``).join(', ')} may stand before it). ` +
          'Move it to the top of the file.');
      }
    } else if (!any.has(a.action)) {
      sawAction = true;
    }
    if (a.action === 'UNITS') {
      const l = keywordValue(a, 'LENGTH');
      if (l) units = { length: l };
    }

    /* --- the action itself --- */
    if (syntax && !s) {
      const near = nearestAction(a.action, syntax);
      if (loads) {
        // An action a LOAD file adds is often named after the one it was
        // copied from, DISTANCE2 after DISTANCE.
        add('note', a.line,
          `\`${a.action}\` is not part of PLUMED ${syntax.version}; it is taken to come from a ` +
          '`LOAD` file, so its keywords are not checked.' +
          (near ? ` If it is not, did you mean \`${near}\`?` : ''));
      } else {
        add(near ? 'error' : 'warning', a.line, near
          ? `\`${a.action}\` is not an action of PLUMED ${syntax.version}. Did you mean \`${near}\`?`
          : `\`${a.action}\` is not in the keyword table of PLUMED ${syntax.version}. Check the ` +
            'name and the target version; an action of a module that needs an extra library ' +
            'is not listed.');
      }
    }
    if (s) {
      const needed = typeof s.modulesFor === 'function' ? s.modulesFor(a.action) : [s.moduleOf(a.action)];
      for (const m of needed) {
        if (!m || m.defaultOn) continue;
        if (!modules.has(m.name)) modules.set(m.name, { line: a.line, actions: [] });
        const entry = modules.get(m.name);
        if (!entry.actions.includes(a.action)) entry.actions.push(a.action);
      }
      const expansion = typeof s.expansion === 'function' ? s.expansion(a.action).slice(1) : [];
      const seen = new Set();
      for (const k of a.keywords) {
        const kw = lookupKeyword(s, a.action, k);
        if (!kw) {
          // A shortcut hands the rest of its line to the actions it creates.
          if (expansion.some(b => lookupKeyword(s, b, k))) continue;
          const names = s.action(a.action).keywords.map(x => x.name);
          const exactly = names.find(n => n.toUpperCase() === k.key.toUpperCase());
          if (exactly && k.value === null) {
            add('error', a.line,
              `\`${k.key}\` is written \`${exactly}\` for \`${a.action}\`: PLUMED matches a flag ` +
              'exactly as it is registered, and stops at any other spelling.');
            continue;
          }
          const near = nearestKeyword(k.key, names);
          add('error', a.line,
            `\`${k.key}\` is not a keyword of \`${a.action}\` in PLUMED ${syntax.version}.` +
            (near ? ` Did you mean \`${near}\`?` : '') +
            ' PLUMED stops at a word it cannot understand.');
          continue;
        }
        if (kw.style === 'flag' && k.value !== null) {
          add('error', a.line,
            `\`${k.key}\` is a flag of \`${a.action}\`: write it alone, without \`=${k.value}\`. ` +
            'PLUMED stops at the whole word.');
        }
        // A reduction such as MEAN is written alone; MORE_THAN takes a value.
        if (kw.style !== 'flag' && kw.style !== 'reduction' && k.value === null) {
          add('error', a.line, `\`${k.key}\` of \`${a.action}\` needs a value: \`${k.key}=...\`.`);
        }
        if (k.value !== null && k.value === '') {
          add('error', a.line, `\`${k.key}=\` of \`${a.action}\` has no value.`);
        }
        const id = k.value === null ? k.key : k.key.toUpperCase();
        if (seen.has(id)) {
          add('error', a.line, `\`${k.key}\` is given twice on \`${a.action}\`.`);
        }
        seen.add(id);
      }
      /* --- compulsory keywords that have no default --- */
      // A shortcut that builds several actions fills some of them in itself,
      // so only the others are checked. R_0 (or LOWER and UPPER) is not
      // needed once SWITCH describes the whole function, and a few actions read a
      // keyword only in some modes (found on PLUMED's regression tests).
      // What the action it hands its line to requires is required all the
      // same: RESTRAINT stops without AT, since RESTRAINT_SCALAR does.
      const builds = typeof s.needs === 'function' && s.needs(a.action).length > 0;
      const handed = builds && typeof s.passesTo === 'function'
        ? new Set(s.passesTo(a.action).flatMap(b => s.requiredKeywords(b))) : new Set();
      const required = s.requiredKeywords(a.action).filter(n => !builds || handed.has(n));
      for (const name of required) {
        if (sets(a, name)) continue;
        if (SWITCH_PARTS.has(name) && sets(a, 'SWITCH')) continue;
        if ((OPTIONAL_IN_PRACTICE[a.action] || []).includes(name)) continue;
        add('error', a.line,
          `\`${a.action}\` needs \`${name}\`, a compulsory keyword without a default. ` +
          'PLUMED stops when it is missing.');
      }
    }

    /* --- label --- */
    if (a.label) {
      if (labels.has(a.label)) {
        add('error', a.line,
          `The label \`${a.label}\` is used twice, first on line ${seenAt.get(a.label)}. ` +
          'PLUMED requires unique labels.');
      }
      if (s && !s.keyword(a.action, 'LABEL')) {
        add('error', a.line,
          `\`${a.action}\` takes no label: PLUMED stops at \`LABEL=${a.label}\`. Remove ` +
          `\`${a.label}:\`.`);
      }
      if (a.label.includes('.')) {
        add('warning', a.line,
          `The label \`${a.label}\` contains a dot. PLUMED accepts it with a warning, but reads ` +
          `\`${a.label}\` in an argument as a component of \`${a.label.split('.')[0]}\`, so nothing ` +
          'can refer to it.');
      }
      if (a.label.startsWith('@')) {
        add('warning', a.line,
          `The label \`${a.label}\` starts with @. PLUMED accepts it, but in an atom list a word ` +
          'starting with @ is read as a selection of the MOLINFO structure.');
      }
    }

    /* --- what it refers to --- */
    for (const k of a.keywords) {
      if (k.value === null) continue;
      const style = s ? (lookupKeyword(s, a.action, k) || {}).style : null;
      if (/^ARG\d*$/.test(k.key) && style !== 'atoms' && !k.braced) {
        for (const ref of listOf(k.value)) {
          if (isLiteralReference(ref) || open || k.value.includes('@replicas')) continue;
          const wild = wildcardLabel(ref);
          if (wild === '') continue;
          const target = wild === null ? ref : wild;
          const owner = resolve(target);
          if (!owner) {
            const later = actions.find(x => x.line > a.line && x.label &&
              resolveReference(target, new Set([x.label]), { prefixed: () => makesPrefixed(syntax, x.action) }));
            add('error', a.line, later
              ? `\`${a.action}\` uses \`${ref}\`, which is only defined on line ${later.line}. ` +
                'PLUMED reads the file in order: move the definition above this line.'
              : `\`${a.action}\` uses \`${ref}\`, which nothing in the file defines.`);
            continue;
          }
          if (wild !== null || !syntax) continue;
          const d = defs.get(owner);
          const rest = target.slice(owner.length);
          // From 2.10 `x.sum` of a shortcut is whatever action is labelled
          // `x_sum`, even one the file defines itself.
          if (rest.startsWith('.') && labels.has(`${owner}_${rest.slice(1)}`)) continue;
          const problem = rest === '' ? componentProblem(d, null, syntax)
            : rest.startsWith('.') ? componentProblem(d, rest.slice(1), syntax) : null;
          if (problem) add('error', a.line, `\`${a.action}\` uses \`${ref}\`: ${problem}`);
        }
      }
      if (LABEL_KEYS.test(k.key) && !open && s && style !== 'atoms') {
        for (const l of parseAtomList(k.value).labels) {
          if (l.startsWith('@') || resolve(l)) continue;
          add('error', a.line,
            `\`${k.key}\` of \`${a.action}\` names \`${l}\`, which is not defined above it.`);
        }
      }
      if (style === 'atoms' || (!s && ATOM_KEYS.test(k.key))) {
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
            if (l.startsWith('@') || resolve(l)) continue;
            add('error', a.line,
              `\`${k.key}\` of \`${a.action}\` uses \`${l}\`, which is not a group or a centre ` +
              'defined above it.');
          }
        }
        // Every @ word but these few is read from the MOLINFO structure.
        if (parsedAtoms.labels.some(l => l.startsWith('@') && !NO_MOLINFO.test(l)) &&
          !actions.some(x => x.action === 'MOLINFO' && x.line < a.line) && !open) {
          add('error', a.line,
            `\`${a.action}\` uses a \`@\` selection, which needs a \`MOLINFO\` line above it.`);
        }
      }
      /* --- switching functions --- */
      // BETWEEN reads a histogram bead (GAUSSIAN LOWER= UPPER= SMEAR=), not a
      // switching function, and UPDATE_IF takes numbers for MORE_THAN.
      if (SWITCH_KEYS.test(k.key) && (!s || style !== 'atoms') && a.action !== 'BETWEEN' &&
        /^[A-Za-z]/.test(k.value.trim())) {
        for (const p of switchProblems(k.value, syntax ? syntax.version : '')) {
          add('error', a.line, `The switching function in \`${k.key}\` of \`${a.action}\` ${p}`);
        }
      }
      if (k.braced || ['R_0', 'D_0', 'D_MAX'].includes(k.key)) {
        const nm = LENGTH_IN_NM[units.length] || (Number(units.length) > 0 ? Number(units.length) : 1);
        const pairs = k.braced
          ? splitWords(k.value).words.map(splitKeyword).map(x => ({ ...x, key: x.key.toUpperCase() }))
          : [{ key: k.key, value: k.value }];
        const isSwitch = !k.braced || Object.prototype.hasOwnProperty.call(SWITCH_TYPES,
          splitWords(k.value).words[0] || '');
        // The function actions MORE_THAN, LESS_THAN and BETWEEN switch a value,
        // not a distance.
        const onValue = VALUE_SWITCH_ACTIONS.has(a.action) ||
          (s && (s.moduleOf(a.action) || {}).name === 'function');
        if (isSwitch && DISTANCE_SWITCH.test(k.key) && !onValue) {
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

    /* --- atoms an action takes, and neighbour lists --- */
    const fixed = ATOM_COUNT[a.action];
    if (fixed && keywordValue(a, 'ATOMS') && !a.keywords.some(k => /^ATOMS\d+$/.test(k.key))) {
      const n = atomCount(keywordValue(a, 'ATOMS'), defs);
      if (n !== null && !fixed.includes(n) && !(a.action === 'TORSION' && sets(a, 'VECTORA'))) {
        add('error', a.line,
          `\`${a.action}\` takes ${fixed.join(' or ')} atoms in \`ATOMS\`, but ${n} ` +
          `${n === 1 ? 'is' : 'are'} listed. PLUMED stops here.`);
      }
    }
    if (NLIST_ACTIONS.has(a.action) && hasFlag(a, 'NLIST')) {
      for (const key of ['NL_CUTOFF', 'NL_STRIDE']) {
        const v = numberOf(keywordValue(a, key));
        if (v === null || v <= 0) {
          add('error', a.line,
            `\`${a.action}\` sets \`NLIST\` without a positive \`${key}\`; PLUMED stops when the ` +
            'neighbour list has no cutoff or stride.');
        }
      }
    }

    /* --- one value per argument --- */
    const per = PER_ARG[a.action];
    const args = listOf(keywordValue(a, 'ARG'));
    // Adaptive hills take one width for all; partitioned families and vector
    // arguments pair values with something other than the argument list. A
    // single argument is checked only when it is surely one number.
    const scalarArg = (ref) => {
      const owner = defs.get(resolve(ref) || '');
      return !!(owner && syntax && syntax.has(owner.action) &&
        !(typeof syntax.needs === 'function' && syntax.needs(owner.action).length) &&
        !owner.keywords.some(k => /\d+$/.test(k.key) && /^(ATOMS|ARG|GROUP)/.test(k.key)));
    };
    const fixedCount = args.length > 0 && !args.some(isLiteralReference) &&
      !args.some(x => /[*?]/.test(x)) &&
      (args.length > 1 || scalarArg(args[0])) &&
      !keywordValue(a, 'ADAPTIVE') && !a.keywords.some(k => /^PF\d+$/.test(k.key));
    if (per && fixedCount) {
      for (const key of per) {
        const v = keywordValue(a, key);
        if (!v || /^ADAPTIVE$/i.test(v) || v.includes('@replicas')) continue;
        const n = listOf(v).length;
        if (n !== args.length) {
          add('error', a.line,
            `\`${a.action}\` has ${args.length} argument${args.length === 1 ? '' : 's'} but ` +
            `\`${key}\` has ${n} value${n === 1 ? '' : 's'}. PLUMED needs one per argument, ` +
            'and a single value is not repeated.');
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
          const ref = args[j];
          // PLUMED compares the grid of a periodic variable with its period
          // as text (bias/MetaD.cpp), so -3.1416 for -pi stops the run.
          const owner = ref && !open ? defs.get(resolve(ref) || '') : null;
          const period = owner ? periodOf(owner, ref === owner.label ? '' : ref.slice(owner.label.length + 1)) : null;
          if (period && (l !== period[0] || hi[j] !== period[1])) {
            add('error', a.line,
              `\`${a.action}\`: \`${ref}\` is periodic on \`${period[0]}..${period[1]}\`, so PLUMED ` +
              `stops unless its GRID_MIN and GRID_MAX read exactly \`${period[0]}\` and ` +
              `\`${period[1]}\`; they read \`${l}\` and \`${hi[j]}\`.`);
            return;
          }
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
      // Without WALKERS_N there is one walker, so any WALKERS_ID but 0 stops
      // PLUMED (bias/MetaD.cpp).
      const wid = numberOf(keywordValue(a, 'WALKERS_ID'));
      const given = numberOf(keywordValue(a, 'WALKERS_N'));
      const wn = given !== null ? given : 1;
      if (wid !== null && wid >= wn) {
        add('error', a.line, given !== null
          ? `\`WALKERS_ID=${wid}\` must be below \`WALKERS_N=${wn}\`: walkers count from 0.`
          : `\`WALKERS_ID=${wid}\` without \`WALKERS_N\`: PLUMED then counts one walker, whose ` +
            'id is 0, and stops. Set `WALKERS_N` to the number of walkers.');
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
      defs.set(a.label, a);
    }
  }

  for (const [name, m] of modules) {
    const all = [...modules.keys()];
    add('note', m.line,
      `${m.actions.map(x => `\`${x}\``).join(', ')} need${m.actions.length === 1 ? 's' : ''} the ` +
      `**${name}** module, which a default PLUMED ${syntax.version} build leaves out. Check with ` +
      `\`plumed config has module ${name}\`` +
      (all.length > 1 ? `; the input needs \`--enable-modules=${all.join(':')}\`.` : '.'));
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
  const restarting = !!restart && !hasFlag(restart, 'NO');
  for (const a of actions) {
    if (!['PRINT', 'METAD', 'OPES_METAD', 'DUMPATOMS', 'DUMPGRID'].includes(a.action)) continue;
    const f = keywordValue(a, 'FILE') || (a.action === 'METAD' ? 'HILLS' : a.action === 'OPES_METAD' ? 'KERNELS' : '');
    if (!f) continue;
    if (files.has(f)) {
      // PLUMED backs up a file it finds when it opens it, unless it restarts.
      add('warning', a.line,
        `\`${a.action}\` writes to \`${f}\`, which line ${files.get(f)} already writes to. ` +
        (restarting
          ? 'With RESTART both append to it, so their lines interleave; give each its own file.'
          : `When this line opens it, PLUMED moves the first output to \`bck.0.${f}\`, so it is ` +
            'lost to the analysis; give each its own file.'));
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
    // Case aside: a flag is matched exactly, so LOGACTIVITY is a letter-case
    // away from logActivity, not eight letters.
    const d = editDistance(String(word).toUpperCase(), String(c).toUpperCase());
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
  // Who uses what, read the way PLUMED resolves it: an argument, an atom or
  // group, a label named by LOGWEIGHTS or SPECIES. An exact label wins, so
  // `d_1` is a use of the action `d_1`, not of `d`.
  const used = new Map();
  const labels = new Set();
  const byLabel = new Map();
  const prefixed = (l) => makesPrefixed(syntax, (byLabel.get(l) || {}).action);
  const note = (owner, ref, who) => {
    if (!used.has(owner)) used.set(owner, { refs: [], by: [] });
    const u = used.get(owner);
    if (!u.refs.includes(ref)) u.refs.push(ref);
    if (!u.by.includes(who)) u.by.push(who);
  };
  for (const a of actions) {
    const who = a.label || a.action;
    for (const k of a.keywords) {
      if (k.value === null || k.braced) continue;
      const argLike = /^ARG\d*$/.test(k.key) || /^LOGWEIGHTS$/.test(k.key);
      const atomLike = ATOM_KEYS.test(k.key) || LABEL_KEYS.test(k.key);
      for (const ref of listOf(k.value)) {
        if (isLiteralReference(ref) || /[*?]/.test(ref)) continue;
        let owner = null;
        if (argLike || atomLike) owner = resolveReference(ref, labels, { prefixed });
        else if (labels.has(ref)) owner = ref;
        if (owner && owner !== a.label) note(owner, ref, who);
      }
    }
    if (a.label) { labels.add(a.label); byLabel.set(a.label, a); }
  }
  return actions.filter(a => a.action).map((a) => {
    const info = syntax && syntax.has(a.action) ? syntax.action(a.action) : null;
    let summary = PLAIN[a.action] || (info ? sentence(info.description) : '');
    if (a.action === 'RESTART' && hasFlag(a, 'NO')) {
      summary = 'Switches restarting off for this run, whatever the MD engine asks: outputs are ' +
        'backed up and written anew.';
    }
    if (!summary) {
      summary = 'Not an action of this PLUMED version; it may come from a LOAD file.';
    }
    const keywords = a.keywords.map((k) => {
      const kw = info ? lookupKeyword(syntax, a.action, k) : null;
      return { key: k.key, value: k.value, meaning: kw ? sentence(kw.description) : '' };
    });
    let outputs = '';
    if (a.label) {
      const u = used.get(a.label);
      if (u) {
        outputs = `Used as ${u.refs.map(r => `\`${r}\``).join(', ')} by ${u.by.map(x => `\`${x}\``).join(', ')}.`;
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
    // A field written under another keyword (PLANE's ATOMS as ATOMS1).
    const f = byKey.get(k.key) || fields.find(x => x.writeAs === k.key);
    const text = k.value === null ? null : (k.braced ? `{${k.value}}` : k.value);
    if (f && !f.variant && !f.k.startsWith('__')) {
      if (f.type === 'flag') {
        if (k.value !== null) return null;
        values[f.k] = true;
      } else {
        if (k.value === null) return null;
        values[f.k] = text;
      }
      continue;
    }
    if (folds && k.key === 'SWITCH' && k.braced) {
      const parts = splitWords(k.value).words;
      // PLUMED reads the type exactly as written; anything else stays as it is.
      if ((parts[0] || '') !== 'RATIONAL') return null;
      for (const p of parts.slice(1).map(splitKeyword)) {
        const key = p.key.toUpperCase();
        if (!byKey.has(key) || p.value === null) return null;
        values[key] = p.value;
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
    // A text field holding numbered keywords as one fragment, ATOMS1=.. ATOMS2=..;
    // a field of atoms cannot, since it is written as ATOMS=<list>.
    const holder = fields.find(x => x.type === 'text' && /\w+\d+=/.test(String(x.def)) &&
      new RegExp(`\\b${base}\\d+=`).test(String(x.def)));
    const own = byKey.has(base) && /\d+$/.test(k.key) ? byKey.get(base) : null;
    const home = holder || (own && own.type === 'text' ? own : null);
    if (home && text !== null) {
      (fragments[home.k] = fragments[home.k] || []).push(`${k.key}=${text}`);
      continue;
    }
    return null;
  }
  // The form writes one block as MORE_THAN= and several as MORE_THAN1=,
  // MORE_THAN2=, ...; a lone MORE_THAN1, a gap, or both forms cannot be
  // written back, so such a line stays as it is.
  for (const [key, list] of Object.entries(numbered)) {
    const nums = a.keywords.filter(x => x.key.replace(/\d+$/, '') === key && x.key !== key)
      .map(x => Number(x.key.slice(key.length)));
    if (list.length < 2 || !nums.every((n, i) => n === i + 1) || !blankOf(values[key])) return null;
    values[key] = list.join('; ');
  }
  for (const [key, list] of Object.entries(fragments)) values[key] = list.join(' ');
  return values;
}

const blankOf = (v) => v === undefined || v === null || v === false || String(v).trim() === '';

/* Actions that define no value, so a PRINT of everything leaves them out. */
const NO_VALUE = new Set([
  'DUMPATOMS', 'DUMPDERIVATIVES', 'DUMPFORCES', 'DUMPMASSCHARGE', 'DUMPGRID', 'DUMPCUBE',
  'DUMPVECTOR', 'DUMPPDB', 'DUMPPROJECTIONS', 'DUMPMULTICOLVAR', 'FLUSH', 'WHOLEMOLECULES',
  'WRAPAROUND', 'FIT_TO_TEMPLATE', 'RESET_CELL', 'FIXEDATOM', 'GHOST', 'GROUP', 'CENTER', 'COM',
  'CENTER_FAST', 'PRINT', 'DEBUG', 'UPDATE_IF', 'COMMITTOR', 'EFFECTIVE_ENERGY_DRIFT', 'MOLINFO',
  'INCLUDE', 'LOAD', 'RESTART', 'UNITS', 'PRINT_NDX', 'DUMPPATH', 'OUTPUT_CLUSTER'
]);
/* The components the builder's bias line has, as generatePlumedInput writes it. */
function builderComponents(method, a) {
  const args = listOf(keywordValue(a, 'ARG'));
  switch (method) {
    case 'metad':
    case 'wt_metad':
      return hasFlag(a, 'CALC_RCT') ? ['bias', 'rbias', 'rct'] : ['bias'];
    case 'opes': return ['bias', 'rct', 'zed', 'neff', 'nker'];
    case 'moving': return ['bias', 'work'];
    case 'abmd': return ['bias', ...args.map(x => `${x}_min`), ...args.map(x => `${x.replace('.', '_')}_min`)];
    default: return ['bias'];
  }
}

/* Actions that take no label: PLUMED stops at LABEL= on them. */
const NO_LABEL = new Set(['VES_OUTPUT_FES', 'WHAM_WEIGHTS', 'FLUSH', 'UNITS', 'RESTART', 'MOLINFO']);
/* Actions that read the biases without naming them (ARG defaults to *.bias). */
const READS_BIASES = new Set(['REWEIGHT_BIAS', 'REWEIGHT_METAD']);
const SETUP_KINDS = new Set(['UNITS', 'RESTART', 'LOAD', 'INCLUDE', 'FLUSH', 'MOLINFO', 'WHOLEMOLECULES']);
/* Where the builder writes each kind of line; a line may only use lines
   written before it. */
const RANK = { setup: 0, cv: 1, custom: 1, function: 2, bias: 3, restraint: 4, print: 5 };
const WALL_KEYS = { upper: ['ARG', 'AT', 'KAPPA', 'EXP', 'EPS', 'OFFSET'],
  lower: ['ARG', 'AT', 'KAPPA', 'EXP', 'EPS', 'OFFSET'], restraint: ['ARG', 'AT', 'KAPPA'] };

/**
 * Turn a PLUMED input into a description `generatePlumedInput` accepts, so
 * that an existing file can be edited in the builder.
 *
 * An action the catalogue covers becomes that entry; any other is kept word
 * for word as a custom line, with the components other lines use from it.
 * The builder writes its lines in a fixed order (variables, functions, the
 * bias, walls, output), so a line that the file uses before that order would
 * reach it, a function a later variable reads for one, is kept as a custom
 * line where it stands. Labels, files, formats and strides are carried over;
 * whatever cannot be is listed in `notes`.
 *
 * @param {string} text
 * @returns {{config:object, notes:string[], fields:object}} `fields` holds the
 *          values of the page's fixed form fields.
 */
export function importPlumedInput(text) {
  const { actions: parsedActions, errors } = parsePlumedInput(text);
  const actions = parsedActions.filter(a => a.action);
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

  /* What each line uses: lines above it. A wildcard, or an action that reads
     every bias, may use any of them, and must not see a line written after
     it in the file. */
  const refsOf = new Map();
  const wild = new Set();
  const before = new Set();
  const byLabel = new Map();
  actions.forEach((a, i) => {
    const refs = new Set();
    const earlier = () => actions.slice(0, i).forEach(x => refs.add(x));
    for (const k of a.keywords) {
      if (k.value === null || k.braced) continue;
      const named = /^ARG\d*$/.test(k.key) || k.key === 'LOGWEIGHTS' || ATOM_KEYS.test(k.key) ||
        LABEL_KEYS.test(k.key);
      for (const ref of listOf(k.value)) {
        if (/[*?]/.test(ref) && /^ARG\d*$/.test(k.key)) { earlier(); wild.add(a); continue; }
        const owner = named ? resolveReference(ref, before) : (before.has(ref) ? ref : null);
        if (owner) refs.add(byLabel.get(owner));
      }
    }
    if (READS_BIASES.has(a.action) && !keywordValue(a, 'ARG')) { earlier(); wild.add(a); }
    refsOf.set(a, refs);
    if (a.label) { before.add(a.label); byLabel.set(a.label, a); }
  });
  const referenced = (label) => actions.some(x => [...refsOf.get(x)].some(b => b.label === label));
  const componentsUsed = (label) => (usedComponents.get(label) || [])
    .filter(c => c.startsWith('.') && !/[*?]/.test(c)).map(c => c.slice(1));
  // PLUMED labels an unlabelled action @0, @1, ... by its place in the file,
  // which rewriting the file changes.
  const auto = new Set();
  for (const a of actions) {
    for (const k of a.keywords) {
      if (k.value !== null && /^ARG\d*$/.test(k.key)) {
        listOf(k.value).filter(r => /^@\d+/.test(r)).forEach(r => auto.add(`Line ${a.line}: \`${r}\``));
      }
    }
  }
  if (auto.size) {
    notes.push(`${[...auto].join('; ')} refers to an action by the label PLUMED gives an unlabelled ` +
      'line, @ and its place in the file, which the rewritten file changes. Label that action and ' +
      'refer to it by name.');
  }

  /* --- what each line becomes --- */
  const kind = new Map();
  let biasAction = null;
  const taken = new Set(labels);
  const freshLabel = (base) => {
    let l = base;
    for (let i = 2; taken.has(l); i++) l = `${base}_${i}`;
    taken.add(l);
    return l;
  };
  for (const a of actions) {
    // One MOLINFO is the builder's; a later one, which changes what the @
    // selections after it mean, stays where it is.
    if (a.action === 'MOLINFO' && actions.some(x => x.action === 'MOLINFO' && x.line < a.line)) {
      kind.set(a, 'custom');
      continue;
    }
    if (SETUP_KINDS.has(a.action)) { kind.set(a, 'setup'); continue; }
    if (a.action === 'PRINT') { kind.set(a, 'print'); continue; }
    if (['COMBINE', 'CUSTOM', 'MATHEVAL'].includes(a.action)) {
      const type = a.action === 'COMBINE' ? 'COMBINE' : 'CUSTOM';
      const known = new Set(FUNCTION_DEFS[type].fields.map(f => f.k));
      const fits = a.label && a.keywords.every(k => k.key === 'ARG' || known.has(k.key));
      kind.set(a, fits ? 'function' : 'custom');
      continue;
    }
    const method = a.action === 'METAD' ? (keywordValue(a, 'BIASFACTOR') ? 'wt_metad' : 'metad')
      : BIAS_METHOD[a.action];
    if (method && !biasAction) {
      // The builder biases one component of each variable; a bias on two of
      // one (gpos.x and gpos.y) stays as written.
      const owners = listOf(keywordValue(a, 'ARG')).map(x => resolveReference(x, labels));
      if (owners.some((o, j) => o && owners.indexOf(o) !== j)) {
        kind.set(a, 'custom');
        notes.push(
          `Line ${a.line}: \`${a.action}\` acts on two values of one variable, which the builder ` +
          'cannot express, so it was kept as a custom line.');
        continue;
      }
      // A component the builder's line would not have (md.acc, opes.work),
      // because the keyword that makes it is one it does not write.
      const lost = a.label ? componentsUsed(a.label).filter(c => !builderComponents(method, a).includes(c)) : [];
      if (lost.length) {
        kind.set(a, 'custom');
        notes.push(
          `Line ${a.line}: \`${a.label}\` is used as ${lost.map(c => `\`${a.label}.${c}\``).join(', ')}, ` +
          'which comes from keywords the builder does not write, so it was kept as a custom line.');
        continue;
      }
      biasAction = a;
      kind.set(a, 'bias');
      taken.add(biasLabelFor(method, {}, a.label));
      continue;
    }
    if (method && ['upper', 'lower', 'restraint'].includes(method)) {
      // A wall beside the bias becomes a restraint of the builder, one per
      // value, when it says nothing more and nothing refers to it by a label
      // that splitting would change.
      const args = listOf(keywordValue(a, 'ARG'));
      const plain = a.keywords.every(k => WALL_KEYS[method].includes(k.key) && k.value !== null);
      const split = args.length > 1 && a.label && referenced(a.label);
      kind.set(a, plain && args.length && !split ? 'restraint' : 'custom');
      continue;
    }
    if (method) {
      notes.push(
        `Line ${a.line}: a second \`${a.action}\` was kept as a custom line. The builder edits ` +
        'one sampling method at a time.');
      kind.set(a, 'custom');
      continue;
    }
    const type = a.label ? entryFor(a.action) : null;
    kind.set(a, type && fillEntry(type, a) ? 'cv' : 'custom');
  }

  /* --- keep the order the file needs ---
     A line the builder would write after one that uses it moves up to where
     the variables are written, in the order of the file, which defined it
     before its use. That may move what it uses in turn. */
  const rank = (a) => RANK[kind.get(a)];
  for (let changed = true; changed;) {
    changed = false;
    actions.forEach((a, i) => {
      if (a.action === 'WHOLEMOLECULES' && refsOf.get(a).size && kind.get(a) === 'setup') {
        kind.set(a, 'custom');
        changed = true;
      }
      // A wildcard sees what is written above it: a line after it in the file
      // must not be written before it, so it stays where it stands instead.
      if (wild.has(a) && kind.get(a) !== 'print' && kind.get(a) !== 'custom' &&
        actions.slice(i + 1).some(b => rank(b) < rank(a) && kind.get(b) !== 'setup')) {
        kind.set(a, 'custom');
        changed = true;
        notes.push(
          `Line ${a.line}: \`${a.label || a.action}\` takes its arguments by a wildcard, so it ` +
          'was kept as a custom line in its place, where it sees the same values as in the file.');
      }
      for (const b of refsOf.get(a)) {
        if (!b || rank(b) <= rank(a) || kind.get(a) === 'print') continue;
        const was = kind.get(b);
        kind.set(b, 'custom');
        changed = true;
        notes.push(
          `Line ${b.line}: \`${b.label || b.action}\` (${b.action}) is used on line ${a.line}, above where the ` +
          `builder writes ${was === 'bias' ? 'the bias' : was === 'function' ? 'functions' : 'walls'}, ` +
          'so it was kept as a custom line in its place.');
        if (was === 'bias') biasAction = null;
      }
    });
  }

  const custom = (a) => {
    const comps = (usedComponents.get(a.label) || []).filter(c => !/[*?]/.test(c));
    const bare = !a.label && NO_LABEL.has(a.action);
    return {
      id: `cv${++seq}`, type: 'CUSTOM', label: a.label || `a${seq}`, bias: false,
      // An action with no value of its own is neither printed nor biased.
      isGroup: NO_VALUE.has(a.action) || bare, noBias: false,
      ...(bare ? { noLabel: true } : {}),
      values: { __raw: rawLine(a), __components: comps.map(c => c.replace(/^\./, '')).join(',') },
      biasValues: defaultBiasValues('CUSTOM'),
      unlabelled: !a.label
    };
  };
  for (const a of actions) {
    const v = (k) => keywordValue(a, k);
    const k = kind.get(a);
    if (k === 'setup') {
      switch (a.action) {
        case 'UNITS':
          if (v('LENGTH')) config.units.length = v('LENGTH');
          if (v('ENERGY')) config.units.energy = v('ENERGY');
          if (v('TIME')) config.units.time = v('TIME');
          break;
        case 'RESTART':
          config.preamble.restart = !hasFlag(a, 'NO');
          break;
        case 'LOAD':
          if (v('FILE')) config.preamble.load.push(v('FILE'));
          break;
        case 'INCLUDE':
          if (v('FILE')) config.preamble.include.push(v('FILE'));
          break;
        case 'FLUSH':
          config.preamble.flush = v('STRIDE');
          break;
        case 'MOLINFO':
          config.molinfo.structure = v('STRUCTURE');
          if (v('MOLTYPE')) config.molinfo.moltype = v('MOLTYPE');
          break;
        case 'WHOLEMOLECULES': {
          config.whole.enabled = true;
          const ents = a.keywords.filter(x => /^ENTITY\d+$/.test(x.key)).map(x => x.value);
          if (ents.length) config.whole.entities = ents.join('\n');
          else config.whole.residues = true;
          break;
        }
        default:
          break;
      }
      continue;
    }
    if (k === 'print') {
      const print = {
        file: v('FILE') || 'COLVAR',
        // PLUMED prints at every step when STRIDE is left out.
        stride: v('STRIDE') || '1',
        extra: '', all: false, args: listOf(v('ARG')), only: true
      };
      if (v('FMT')) print.fmt = v('FMT');
      config.prints.push(print);
      const other = a.keywords.filter(x => !['ARG', 'FILE', 'STRIDE', 'FMT'].includes(x.key));
      if (other.length) {
        notes.push(
          `Line ${a.line}: \`PRINT\` has keywords the builder does not write ` +
          `(${other.map(x => `\`${x.value === null ? x.key : `${x.key}=${x.value}`}\``).join(', ')}). ` +
          'Add them by hand to the file it writes.');
      }
      continue;
    }
    if (k === 'function') {
      const type = a.action === 'COMBINE' ? 'COMBINE' : 'CUSTOM';
      const values = {};
      for (const f of FUNCTION_DEFS[type].fields) values[f.k] = f.type === 'flag' ? false : '';
      for (const x of a.keywords) if (x.key !== 'ARG') values[x.key] = x.value === null ? true : x.value;
      config.functions.push({
        id: `fn${++fnSeq}`, type, label: a.label, args: listOf(v('ARG')), values, bias: false,
        biasValues: { comp: '', min: '-5.0', max: '5.0', bin: '200', sigma: '0.1' }
      });
      continue;
    }
    if (k === 'restraint') {
      const method = BIAS_METHOD[a.action];
      const args = listOf(v('ARG'));
      args.forEach((arg, j) => {
        const at = (key) => { const l = listOf(v(key)); return l.length === 1 ? l[0] : (l[j] || ''); };
        const label = args.length === 1 && a.label ? a.label
          : freshLabel(`${a.label || method}${args.length > 1 ? `_${j + 1}` : ''}`);
        config.restraints.push({
          id: `res${++resSeq}`, type: method, arg, label,
          at: at('AT'), kappa: at('KAPPA'), exp: at('EXP'), eps: at('EPS'), offset: at('OFFSET')
        });
      });
      if (args.length > 1 && a.label) {
        notes.push(
          `Line ${a.line}: \`${a.label}\` acts on ${args.length} values and was split into one ` +
          'wall per value, so its label changed. Nothing in the file referred to it.');
      }
      continue;
    }
    if (k === 'bias') {
      importBias(a);
      continue;
    }
    if (k === 'cv') {
      const type = entryFor(a.action);
      const def = CV_DEFS[type];
      const values = fillEntry(type, a);
      if (def.components === 'pcarmsd') {
        // As many eigenvectors as the file refers to, at least one.
        const used = (usedComponents.get(a.label) || []).map(c => /^\.eig-(\d+)$/.exec(c)).filter(Boolean);
        values.__eigenvectors = String(Math.max(1, ...used.map(m => Number(m[1]) + 1)));
      }
      config.cvs.push({
        id: `cv${++seq}`, type, label: a.label, bias: false, isGroup: !!def.isGroup,
        noBias: !!def.noBias, values, biasValues: defaultBiasValues(type)
      });
      continue;
    }
    config.cvs.push(custom(a));
  }

  function importBias(a) {
    const v = (k) => keywordValue(a, k);
    const method = a.action === 'METAD' ? (v('BIASFACTOR') ? 'wt_metad' : 'metad') : BIAS_METHOD[a.action];
    const args = listOf(v('ARG'));
    config.bias.method = method;
    // The label is kept, as a parameter the page edits too, so that what
    // refers to it (PRINT ARG=mtd.bias) still finds it.
    config.bias.label = a.label || '';
    if (a.label) config.bias.params.LABEL = a.label;
    else {
      notes.push(`Line ${a.line}: \`${a.action}\` had no label; the builder calls it by its usual name.`);
    }
    config.bias.args = args;
    const known = new Set((BIAS_DEFS[method].params || []).map(p => p.k));
    const handled = new Set(['ARG', 'SIGMA', 'GRID_MIN', 'GRID_MAX', 'GRID_BIN', 'CALC_RCT',
      'RCT_USTRIDE', 'WALKERS_MPI', 'WALKERS_N', 'WALKERS_ID', 'WALKERS_DIR', 'WALKERS_RSTRIDE',
      'STATE_WFILE', 'STATE_RFILE', 'STATE_WSTRIDE', 'NLIST', 'FILE']);
    const extra = [];
    for (const x of a.keywords) {
      if (known.has(x.key) && x.value !== null) config.bias.params[x.key] = x.value;
      else if (!handled.has(x.key)) extra.push(x.value === null ? x.key : `${x.key}=${x.value}`);
    }
    if (v('SIGMA') && method === 'opes') config.bias.params.SIGMA = v('SIGMA');
    if (v('TEMP')) config.bias.temp = v('TEMP');
    if (v('PACE')) config.bias.stride = v('PACE');
    if (v('STATE_WSTRIDE')) config.bias.stateStride = v('STATE_WSTRIDE');
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
    // What the builder writes its own way, said where it differs.
    const changed = [];
    if (v('FILE') && !known.has('FILE')) {
      const own = args.map(x => `HILLS.${x.replace(/[^A-Za-z0-9_-]/g, '_')}`).join(',');
      if (v('FILE') !== own) changed.push(`\`FILE=${v('FILE')}\` becomes \`FILE=${own}\``);
    }
    for (const key of ['STATE_WFILE', 'STATE_RFILE']) {
      if (v(key) && v(key) !== 'State.data') changed.push(`\`${key}=${v(key)}\` becomes \`State.data\``);
    }
    if (v('RCT_USTRIDE') && v('RCT_USTRIDE') !== '10') {
      changed.push(`\`RCT_USTRIDE=${v('RCT_USTRIDE')}\` becomes \`10\``);
    }
    if (changed.length) notes.push(`Line ${a.line}: in \`${a.action}\`, ${changed.join(', ')}.`);
    if (extra.length) {
      notes.push(
        `Line ${a.line}: \`${a.action}\` has keywords the builder does not edit ` +
        `(${extra.map(x => `\`${x}\``).join(', ')}). Add them by hand to the file it writes.`);
    }
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
      // A grid without GRID_BIN takes its bins from SIGMA; so does the one
      // written back.
      ...(t.bin || config.bias.grid ? { bin: t.bin } : {}), ...(t.sigma ? { sigma: t.sigma } : {})
    };
  }
  delete config.bias.targets;
  delete config.bias.args;

  const unlabelled = config.cvs.filter(c => c.unlabelled && !c.noLabel);
  config.cvs.forEach(c => { if (c.noLabel) delete c.unlabelled; });
  for (const c of unlabelled) {
    notes.push(
      `\`${c.values.__raw.split(' ')[0]}\` had no label and was given \`${c.label}\`, since the ` +
      'builder labels every line.');
    delete c.unlabelled;
  }
  if (!config.prints.length) {
    // A file that prints nothing is written back printing nothing: a PRINT of
    // everything could name a line whose value only PLUMED knows.
    config.prints.push(actions.length
      ? { file: 'COLVAR', stride: '', extra: '', all: false, args: [], only: true }
      : { file: 'COLVAR', stride: '', extra: '', all: true, args: [] });
    if (actions.length) {
      notes.push('The file has no PRINT, so the output list is left empty. Pick the values to print, if any.');
    }
  }
  const printsAll = config.prints.filter(p => p.args.some(x => /[*?]/.test(x)));
  if (printsAll.length && actions.some(a => a.action !== 'PRINT' && kind.get(a) !== 'setup' &&
    actions.indexOf(a) > actions.findIndex(x => x.action === 'PRINT' && listOf(keywordValue(x, 'ARG')).some(y => /[*?]/.test(y))))) {
    notes.push('A PRINT with a wildcard now comes after every line, so it also prints the values ' +
      'the file defined after it.');
  }

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
