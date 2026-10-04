/**
 * Curve Fitter: the page.
 *
 * The person types an equation in their own names, such as
 * `y = A*exp(-t/tau) + y0`, and the page fits it to their data as they type:
 * parameters with standard errors and confidence intervals, a plot they can
 * style for a paper, and the Python script (scipy curve_fit + matplotlib)
 * that reproduces both.
 *
 * The work is done by stemkit-core:
 *   expression.js     parses the equation, says which names are variables,
 *                     parameters and constants, and writes LaTeX;
 *   nonlinear-fit.js  fits it (Levenberg–Marquardt, matching curve_fit);
 *   fit-python.js     writes the script;
 *   plot-style.js     the one style object the preview and the script share.
 * js/fit-plot.js turns the fit and its style into a figure and holds the
 * style panel; the shared plot area (mountFigure in js/figure-plot.js) draws,
 * sizes and exports it. Every call into them is in the "Plot" section near
 * the end of this file, and they are loaded with a dynamic import, so the
 * rest of the page works even if the plot cannot load.
 *
 * This file is the DOM wiring plus the pieces that belong to the page rather
 * than the core: reading pasted tables (delimiters, header rows, decimal
 * commas), naming columns, matching columns to variables, the presets and
 * samples, number formatting and the result tables. Those pure pieces are
 * exported so they can be exercised without a browser.
 */

import {
  parseEquation, classify, toLatex, toText, symbolToLatex, symbolsOf,
  FUNCTIONS, CONSTANTS, PHYSICAL_CONSTANTS
} from '../src/core/expression.js';
import { fitModel } from '../src/core/nonlinear-fit.js';
import { generateFitScript } from '../src/core/fit-python.js';
import { defaultPlotStyle, normalisePlotStyle } from '../src/core/plot-style.js';

/* ------------------------------------------------------------------ *
 * Reading a pasted or uploaded table
 * ------------------------------------------------------------------ */

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const COMMA_NUMBER_RE = /^[+-]?\d+,\d+(?:[eE][+-]?\d+)?$/;
/* Cells that mean "no value here" rather than a typing slip. */
const MISSING_RE = /^(?:nan|na|n\/a|null|none|-|–|—|\?)$/i;
const COMMENT_RE = /^\s*(?:#|%|@|\/\/)/;

const DELIMITER_NAMES = { '\t': 'tab-separated', ';': 'semicolon-separated', ',': 'comma-separated', ' ': 'space-separated' };

function splitLine(line, delim) {
  if (delim === ' ') return line.trim().split(/\s+/);
  if (delim === '\t') return line.split('\t').map(s => s.trim());
  return splitQuoted(line, delim);
}

/* A comma- or semicolon-separated line, honouring double quotes around cells. */
function splitQuoted(line, delim) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delim) {
      out.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  out.push(cell.trim());
  return out;
}

/**
 * A cell as a number: NaN for a blank or "missing" cell, and for text,
 * which `isText` then reports.
 */
function readCell(raw, decimalComma) {
  let s = String(raw ?? '').trim().replace(/^"(.*)"$/, '$1').trim().replace(/\u2212/g, '-');
  if (s === '' || MISSING_RE.test(s)) return { value: NaN, missing: true };
  if (decimalComma && COMMA_NUMBER_RE.test(s)) s = s.replace(',', '.');
  if (/^[+-]?inf(inity)?$/i.test(s)) return { value: s.startsWith('-') ? -Infinity : Infinity, missing: false };
  if (!NUMBER_RE.test(s)) return { value: NaN, missing: false, text: true };
  return { value: Number(s.replace(/[dD]/, 'e')), missing: false };
}

const isNumericCell = (s, decimalComma) => {
  const c = readCell(s, decimalComma);
  return !c.text && !c.missing;
};

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts) if (c > bestCount || (c === bestCount && v > best)) { best = v; bestCount = c; }
  return { value: best, share: values.length ? bestCount / values.length : 0 };
}

/*
 * The delimiter that splits the lines into the same number of cells, most of
 * them numbers. Ties go to tab, then semicolon, comma and spaces, so that
 * "1,5 2,25" reads as two numbers with decimal commas, not as three cells.
 */
function chooseDelimiter(lines) {
  const sample = lines.slice(0, 60);
  let best = { delim: ' ', score: -1 };
  for (const delim of ['\t', ';', ',', ' ']) {
    if (delim !== ' ' && !sample.some(l => l.includes(delim))) continue;
    const rows = sample.map(l => splitLine(l, delim));
    const m = mode(rows.map(r => r.length));
    if (m.value < 2) continue;
    const cells = (rows.length > 1 ? rows.slice(1) : rows).flat().filter(c => c !== '');
    const numeric = cells.length ? cells.filter(c => isNumericCell(c, delim !== ',')).length / cells.length : 0;
    const score = numeric * m.share;
    if (score > best.score + 1e-9) best = { delim, score };
  }
  return best.delim;
}

/* Header text split on spaces keeps a unit in brackets with its name: "Time (s)". */
function mergeUnits(tokens) {
  const out = [];
  for (const t of tokens) {
    if (out.length && /^[([{]/.test(t)) out[out.length - 1] += ` ${t}`;
    else out.push(t);
  }
  return out;
}

const GREEK_NAMES = {
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'η': 'eta', 'θ': 'theta',
  'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu', 'µ': 'mu', 'ν': 'nu', 'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau',
  'φ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega', 'Δ': 'Delta', 'Ω': 'Omega'
};

/**
 * A name a column can go by in an equation, from its header text: units in
 * brackets are dropped, other characters become underscores, a name longer
 * than one letter is lower-cased ("Time (s)" → time, "T (K)" → T), and a name
 * that is already taken, or is a function or constant, gets a number.
 *
 * @param {string} label - The header text, or '' for none.
 * @param {number} index - Zero-based column number, for `c1`, `c2`, …
 * @param {Set<string>} taken - Names already given; the result is added.
 * @returns {string}
 */
export function columnIdentifier(label, index, taken = new Set()) {
  let s = String(label ?? '').trim();
  s = s.replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ').trim();
  if (Object.hasOwn(GREEK_NAMES, s)) s = GREEK_NAMES[s];
  s = s.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  if (s && [...s].length > 1) s = s.toLowerCase();
  if (!s) s = `c${index + 1}`;
  if (!/^[\p{L}_]/u.test(s)) s = `c${s}`;
  if (Object.hasOwn(FUNCTIONS, s) || Object.hasOwn(CONSTANTS, s)) s = `${s}_1`;
  let name = s;
  for (let k = 2; taken.has(name); k++) name = `${s}_${k}`;
  taken.add(name);
  return name;
}

/**
 * Read a table of numbers pasted or loaded from a file.
 *
 * Delimiters: tab, semicolon, comma or runs of spaces, whichever splits the
 * lines consistently. With a tab, semicolon or space delimiter, `1,5` is read
 * as 1.5. Lines starting with #, %, @ or // are comments; a comment line just
 * before the data that names every column is taken as the header. The first
 * line is a header when it holds text and the lines after it hold numbers.
 * A blank, "NaN" or "n/a" cell is a missing value; text where a number should
 * be is reported. Lines without a single number are skipped and reported.
 *
 * @param {string} text
 * @returns {{columns: {name: string, label: string, values: number[]}[],
 *   rows: number, header: boolean, delimiter: string, decimalComma: boolean,
 *   skipped: {line: number, reason: string}[], issues: {line: number, reason: string}[],
 *   notes: string[]}}
 */
export function parseTable(text) {
  const out = {
    columns: [], rows: 0, header: false, delimiter: ' ', decimalComma: false,
    skipped: [], issues: [], notes: []
  };
  const raw = String(text ?? '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const content = [];
  let lastComment = null;
  let commentBeforeData = null;
  raw.forEach((line, i) => {
    if (line.trim() === '') return;
    if (COMMENT_RE.test(line)) {
      // '@' lines are xvg metadata, never a row of column names.
      lastComment = /^\s*@/.test(line) ? null : { line: i + 1, text: line.replace(COMMENT_RE, '').trim() };
      return;
    }
    if (!content.length) commentBeforeData = lastComment && lastComment.line === i ? lastComment : null;
    content.push({ line: i + 1, text: line });
  });
  if (!content.length) return out;

  const delim = chooseDelimiter(content.map(c => c.text));
  out.delimiter = delim;
  const decimalComma = delim !== ',' && content.some(c => /(^|[\s;\t])[+-]?\d+,\d+([eE][+-]?\d+)?(?=$|[\s;\t])/.test(c.text));
  out.decimalComma = decimalComma;

  const rows = content.map(c => ({ line: c.line, cells: splitLine(c.text, delim) }));
  const numericShare = r => {
    const cells = r.cells.filter(c => c !== '');
    return cells.length ? cells.filter(c => isNumericCell(c, decimalComma)).length / cells.length : 0;
  };

  // Header: a first line with text in it, followed by numbers.
  let headerCells = null;
  const first = rows[0];
  const textCells = first.cells.filter(c => c !== '' && !isNumericCell(c, decimalComma) && !MISSING_RE.test(c));
  const next = rows.slice(1, 4);
  if (textCells.length && next.length && next.some(r => numericShare(r) >= 0.5) && numericShare(first) < 0.5) {
    headerCells = delim === ' ' ? mergeUnits(first.cells) : first.cells;
    rows.shift();
  }

  const width = rows.length ? mode(rows.map(r => r.cells.length)).value : (headerCells ? headerCells.length : 0);
  if (!headerCells && commentBeforeData) {
    const cand = delim === ' ' ? mergeUnits(commentBeforeData.text.split(/\s+/)) : splitLine(commentBeforeData.text, delim);
    if (cand.length === width && cand.every(c => c !== '' && !isNumericCell(c, decimalComma) && !/["']/.test(c))) headerCells = cand;
  }
  if (headerCells && headerCells.length !== width) {
    out.notes.push(`The header names ${headerCells.length} column${headerCells.length === 1 ? '' : 's'} but the rows have ${width}, so the columns are numbered instead.`);
    headerCells = null;
  }
  out.header = Boolean(headerCells);

  const values = Array.from({ length: width }, () => []);
  for (const r of rows) {
    const cells = r.cells;
    const parsed = [];
    let numbers = 0;
    let firstText = null;
    for (let k = 0; k < width; k++) {
      const c = readCell(cells[k], decimalComma);
      parsed.push(c.value);
      if (Number.isFinite(c.value)) numbers++;
      if (c.text && !firstText) firstText = { col: k, text: String(cells[k]).trim() };
    }
    if (numbers === 0) {
      out.skipped.push({ line: r.line, reason: firstText ? `no numbers ("${clip(firstText.text)}")` : 'no numbers' });
      continue;
    }
    if (firstText) {
      out.issues.push({ line: r.line, reason: `"${clip(firstText.text)}" in column ${firstText.col + 1} is not a number` });
    } else if (cells.length < width) {
      out.issues.push({ line: r.line, reason: `${cells.length} value${cells.length === 1 ? '' : 's'} where the other rows have ${width}` });
    } else if (cells.length > width) {
      out.issues.push({ line: r.line, reason: `${cells.length} values where the other rows have ${width}; the extra ones are ignored` });
    }
    parsed.forEach((v, k) => values[k].push(v));
  }
  out.rows = values.length ? values[0].length : 0;
  const taken = new Set();
  out.columns = values.map((vals, k) => {
    const label = headerCells ? String(headerCells[k]).trim() : '';
    return { name: columnIdentifier(label, k, taken), label, values: vals };
  });
  return out;
}

function clip(s, n = 24) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/* Names and headers that mark a column of uncertainties. */
const SIGMA_RE = /^(?:σ|sigma|s_?y|d_?y|δ_?y|delta_?y|err|errs|error|errors|yerr|y_?err|e_?y|unc|uncert|uncertainty|u_?y|sd|std|stdev|stderr|se|dev)(?:_\d+)?$/i;

/** True when a column looks like it holds the uncertainties of y. */
export function looksLikeSigma(col) {
  if (!col) return false;
  return SIGMA_RE.test(col.name) || /±|\+\/-|\berr(or)?\b|uncert|std\.?\s*dev|σ|sigma/i.test(col.label || '');
}

/* Words for a variable, beyond its own name, when matching column headers. */
const ALIASES = {
  t: ['time'], T: ['temp', 'temperature'], V: ['voltage', 'potential'], I: ['current', 'intensity'],
  P: ['pressure'], p: ['pressure'], c: ['conc', 'concentration'], S: ['substrate', 'conc', 'concentration'],
  f: ['freq', 'frequency'], E: ['energy', 'field'], r: ['radius', 'distance'], d: ['distance', 'depth'],
  lambda: ['wavelength', 'wl'], omega: ['angular_frequency'], v: ['velocity', 'rate', 'speed']
};

/**
 * The column a name refers to: the same name, the same letters in another
 * case, a common word for it ("t" and "time"), or a single letter that starts
 * exactly one header ("T" and "temperature").
 *
 * @param {string} name
 * @param {{name: string, label: string}[]} columns
 * @param {Set<number>} [used] - Columns already given to other names.
 * @returns {number} The column index, or -1.
 */
export function matchColumn(name, columns, used = new Set()) {
  const free = columns.map((c, i) => ({ c, i })).filter(({ i }) => !used.has(i));
  const hit = test => {
    const found = free.filter(({ c }) => test(c));
    return found.length === 1 ? found[0].i : found.length > 1 ? found[0].i : -1;
  };
  let k = hit(c => c.name === name);
  if (k >= 0) return k;
  const lower = name.toLowerCase();
  const ci = free.filter(({ c }) => c.name.toLowerCase() === lower);
  if (ci.length === 1) return ci[0].i;
  const words = ALIASES[name] || [];
  k = hit(c => words.includes(c.name.toLowerCase()) || words.some(w => c.name.toLowerCase().startsWith(`${w}_`)));
  if (k >= 0) return k;
  if ([...name].length === 1 && /\p{L}/u.test(name)) {
    const starts = free.filter(({ c }) => c.label && c.name.length > 1 && c.name[0] === lower);
    if (starts.length === 1) return starts[0].i;
  }
  return -1;
}

/** The value a "row number" choice stands for in a column select. */
export const ROW_NUMBER = -1;

/**
 * Give each variable a column: the one the person chose, else one whose name
 * matches, else the next unused column in order (variables first, then the
 * measured quantity). Uncertainty columns are only taken by name or by choice.
 *
 * @param {string[]} independent
 * @param {string} dependent
 * @param {{name: string, label: string}[]} columns
 * @param {Object<string, number|null>} chosen - Name → column index, ROW_NUMBER,
 *   and `sigma` → column index or null for none. Unknown or out-of-range
 *   choices are ignored.
 * @returns {{columns: Object<string, number>, sigma: number|null, auto: Set<string>}}
 */
export function mapColumns(independent, dependent, columns, chosen = {}) {
  const map = {};
  const used = new Set();
  const auto = new Set();
  const names = [...independent, dependent];
  const valid = (k, allowRow) => Number.isInteger(k) && ((k >= 0 && k < columns.length) || (allowRow && k === ROW_NUMBER));
  let sigma = null;
  const sigmaChoice = Object.hasOwn(chosen, '\u03c3') ? chosen['\u03c3'] : undefined;
  if (sigmaChoice !== undefined && (sigmaChoice === null || valid(sigmaChoice, false))) {
    sigma = sigmaChoice;
    if (sigma !== null) used.add(sigma);
  }
  for (const n of names) {
    const k = chosen[n];
    if (valid(k, n !== dependent) && !(k >= 0 && used.has(k))) {
      map[n] = k;
      if (k >= 0) used.add(k);
    }
  }
  for (const n of names) {
    if (Object.hasOwn(map, n)) continue;
    const k = matchColumn(n, columns, used);
    if (k >= 0) { map[n] = k; used.add(k); auto.add(n); }
  }
  if (sigmaChoice === undefined) {
    const k = columns.findIndex((c, i) => !used.has(i) && looksLikeSigma(c));
    if (k >= 0) { sigma = k; used.add(k); auto.add('\u03c3'); }
  }
  for (const n of names) {
    if (Object.hasOwn(map, n)) continue;
    let k = columns.findIndex((c, i) => !used.has(i) && !looksLikeSigma(c));
    if (k < 0) k = columns.findIndex((c, i) => !used.has(i));
    if (k >= 0) { map[n] = k; used.add(k); auto.add(n); }
  }
  return { columns: map, sigma, auto };
}

/* ------------------------------------------------------------------ *
 * The equation: which names are variables
 * ------------------------------------------------------------------ */

/**
 * Sort the names of a parsed equation into variables, parameters and
 * constants, starting from `classify`'s reading and applying the person's
 * choices.
 *
 * The variables are those listed in `f(x) =`, else classify's guess (x, t, T,
 * V, …), else the names that match a column header. `roles` then moves names
 * either way: `{ S: 'variable', t: 'parameter' }`. `asParameters` lists
 * constants (pi, e) the person wants fitted.
 *
 * @param {object} eq - A successful parseEquation result.
 * @param {{name: string}[]} columns
 * @param {Object<string, 'variable'|'parameter'>} [roles]
 * @param {string[]} [asParameters]
 * @returns {{dependent: string, independent: string[], parameters: string[],
 *   constants: string[], suggestedConstants: object[], notes: string[],
 *   names: string[], guessed: boolean}}
 */
export function resolveRoles(eq, columns, roles = {}, asParameters = []) {
  const dependent = eq.dependent || 'y';
  const { identifiers } = symbolsOf(eq.ast);
  const forced = asParameters.filter(n => identifiers.includes(n));
  const constantNames = new Set(Object.keys(CONSTANTS).filter(c => !forced.includes(c)));
  const names = identifiers.filter(n => n !== dependent && !constantNames.has(n));
  let base = classify(eq, { parameters: forced });
  // classify takes a lone x0 for the start of a family x0, x1, …; as the only
  // guess it is almost always a parameter (a peak centre, an offset).
  if (!(eq.arguments && eq.arguments.length) && base.independent.length === 1 && /^x_?0$/.test(base.independent[0])) {
    base = classify(eq, { parameters: [...forced, base.independent[0]] });
  }
  let independent = base.independent.filter(n => names.includes(n) || (eq.arguments || []).includes(n));
  let guessed = true;
  if (eq.arguments && eq.arguments.length) guessed = false;
  // A guess is only a guess: when the guessed name is not a column of the
  // data but another name in the equation is, that column is the variable
  // (v = Vmax*S^n/(K^n + S^n) with columns S and v varies in S, not in n).
  // A column of uncertainties does not count: sigma is also a width.
  if (guessed && independent.length) {
    const dataNames = new Set(columns.filter(c => !looksLikeSigma(c)).map(c => c.name));
    if (!independent.some(n => dataNames.has(n))) {
      const fromData = names.filter(n => dataNames.has(n));
      if (fromData.length) independent = fromData;
    }
  }
  if (!independent.length) {
    const colNames = new Set(columns.map(c => c.name));
    independent = names.filter(n => colNames.has(n));
  }
  const set = new Set(independent);
  for (const n of names) {
    if (roles[n] === 'variable') set.add(n);
    else if (roles[n] === 'parameter') set.delete(n);
  }
  // Order of first appearance, except that f(x, y) = keeps its own order.
  const order = eq.arguments && eq.arguments.length ? [...eq.arguments, ...names] : names;
  independent = [...new Set(order)].filter(n => set.has(n));
  const info = classify(eq, { independent, parameters: forced });
  return {
    dependent,
    independent,
    parameters: info.parameters,
    constants: info.constants,
    suggestedConstants: info.suggestedConstants,
    notes: info.notes,
    names,
    guessed
  };
}

/* ------------------------------------------------------------------ *
 * Presets and samples
 * ------------------------------------------------------------------ */

/**
 * Ready equations. `{x}` and `{y}` stand for the person's own variable names
 * when they have some; `x` and `y` give the names used otherwise. `bounds`
 * and `fixed` are applied to the parameters when the preset is chosen.
 */
export const PRESETS = [
  { id: 'line', label: 'Line', eq: '{y} = m*{x} + c' },
  { id: 'quadratic', label: 'Quadratic', eq: '{y} = a*{x}^2 + b*{x} + c' },
  { id: 'cubic', label: 'Cubic', eq: '{y} = a*{x}^3 + b*{x}^2 + c*{x} + d' },
  { id: 'decay', label: 'Exponential decay', eq: '{y} = A*exp(-{x}/tau) + y0' },
  { id: 'growth', label: 'Exponential growth', eq: '{y} = A*exp(k*{x})' },
  { id: 'double', label: 'Double exponential', eq: '{y} = A1*exp(-{x}/tau1) + A2*exp(-{x}/tau2) + y0' },
  { id: 'power', label: 'Power law', eq: '{y} = A*{x}^n' },
  { id: 'log', label: 'Logarithmic', eq: '{y} = a + b*ln({x})' },
  { id: 'gauss', label: 'Gaussian', eq: '{y} = A*exp(-({x} - mu)^2/(2*sigma^2)) + y0', bounds: { sigma: { min: 0 } } },
  { id: 'lorentz', label: 'Lorentzian', eq: '{y} = A/(1 + (({x} - x0)/w)^2) + y0', bounds: { w: { min: 0 } } },
  { id: 'pvoigt', label: 'Pseudo-Voigt', eq: '{y} = A*(eta/(1 + (({x} - x0)/w)^2) + (1 - eta)*exp(-ln(2)*(({x} - x0)/w)^2)) + y0', bounds: { w: { min: 0 }, eta: { min: 0, max: 1 } } },
  { id: 'logistic', label: 'Logistic', eq: '{y} = L/(1 + exp(-k*({x} - x0)))' },
  { id: 'mm', label: 'Michaelis\u2013Menten', x: 'S', y: 'v', eq: '{y} = Vmax*{x}/(Km + {x})' },
  { id: 'hill', label: 'Hill', x: 'S', y: 'v', eq: '{y} = Vmax*{x}^n/(K^n + {x}^n)' },
  { id: 'arrhenius', label: 'Arrhenius', x: 'T', y: 'k', eq: '{y} = A*exp(-Ea/(R*{x}))', fixed: { R: PHYSICAL_CONSTANTS.R.value } },
  { id: 'sine', label: 'Sine', eq: '{y} = A*sin(2*pi*{x}/P + phi) + y0', bounds: { P: { min: 0 } } },
  { id: 'damped', label: 'Damped oscillation', eq: '{y} = A*exp(-{x}/tau)*cos(2*pi*{x}/P + phi) + y0', bounds: { P: { min: 0 }, tau: { min: 0 } } }
];

/* How the Models menu groups the presets. */
const PRESET_GROUPS = [
  ['Lines and polynomials', ['line', 'quadratic', 'cubic']],
  ['Exponentials and powers', ['decay', 'growth', 'double', 'power', 'log']],
  ['Peaks', ['gauss', 'lorentz', 'pvoigt']],
  ['Growth, rates and binding', ['logistic', 'mm', 'hill', 'arrhenius']],
  ['Oscillations', ['sine', 'damped']]
];

/**
 * A preset's equation in the given names. A name that would clash with one
 * of the preset's parameters falls back to the preset's own name.
 *
 * @param {object} preset
 * @param {{x?: string, y?: string}} names - The person's variable names, if any.
 * @returns {{text: string, x: string, y: string}}
 */
export function presetEquation(preset, names = {}) {
  const own = { x: preset.x || 'x', y: preset.y || 'y' };
  const params = new Set();
  const probe = parseEquation(preset.eq.replace(/\{x\}/g, own.x).replace(/\{y\}/g, own.y));
  if (probe.ok) symbolsOf(probe.ast).identifiers.forEach(n => { if (n !== own.x) params.add(n); });
  const pick = (wanted, fallback, other) => (wanted && wanted !== other && !params.has(wanted) &&
    !Object.hasOwn(CONSTANTS, wanted) && !Object.hasOwn(FUNCTIONS, wanted) ? wanted : fallback);
  const x = pick(names.x, own.x, names.y);
  const y = pick(names.y, own.y, x);
  return { text: preset.eq.replace(/\{x\}/g, x).replace(/\{y\}/g, y), x, y: y === x ? own.y : y };
}

/* A small seeded generator, so the samples are the same on every visit. */
function seeded(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, normal };
}

const round = (v, digits) => Number(v.toPrecision(digits));
const table = (header, rows) => [header.join('\t'), ...rows.map(r => r.join('\t'))].join('\n');

/**
 * Example datasets, each with the equation it was made from. Values are
 * generated with a fixed seed and rounded as a lab notebook would.
 */
export const SAMPLES = [
  {
    id: 'decay', label: 'Exponential decay',
    equation: 'y = A*exp(-t/tau) + y0',
    make() {
      const g = seeded(11);
      const rows = [];
      for (let i = 0; i < 30; i++) {
        const t = i * 0.25;
        const s = 0.03 + 0.02 * g.next();
        rows.push([t, round(3.2 * Math.exp(-t / 1.7) + 0.4 + s * g.normal(), 4), round(s, 2)]);
      }
      return table(['t (s)', 'signal (mV)', 'sigma (mV)'], rows);
    }
  },
  {
    id: 'line', label: 'Straight line, with errors',
    equation: 'y = m*x + c', absoluteSigma: true,
    make() {
      const g = seeded(7);
      const rows = [];
      for (let i = 1; i <= 12; i++) {
        const dy = round(0.25 + 0.05 * i, 2);
        rows.push([i, round(1.93 * i + 0.4 + dy * g.normal(), 3), dy]);
      }
      return table(['x', 'y', 'dy'], rows);
    }
  },
  {
    id: 'gauss', label: 'Gaussian peak',
    equation: 'y = A*exp(-(x - mu)^2/(2*sigma^2)) + y0', bounds: { sigma: { min: 0 } },
    make() {
      const g = seeded(3);
      const rows = [];
      for (let i = 0; i <= 60; i++) {
        const x = 480 + i * 1;
        rows.push([x, round(1250 * Math.exp(-((x - 511.3) ** 2) / (2 * 6.2 ** 2)) + 90 + 22 * g.normal(), 4)]);
      }
      return table(['x (nm)', 'counts'], rows);
    }
  },
  {
    id: 'mm', label: 'Michaelis\u2013Menten',
    equation: 'v = Vmax*S/(Km + S)',
    make() {
      const g = seeded(5);
      const S = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8];
      return table(['S (mM)', 'v (\u00b5M/min)'], S.map(s => [s, round(42 * s / (0.62 + s) * (1 + 0.03 * g.normal()), 3)]));
    }
  },
  {
    id: 'arrhenius', label: 'Arrhenius',
    equation: 'k = A*exp(-Ea/(R*T))', fixed: { R: PHYSICAL_CONSTANTS.R.value },
    make() {
      const g = seeded(13);
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const T = 290 + 10 * i;
        rows.push([T, round(4.2e9 * Math.exp(-68000 / (PHYSICAL_CONSTANTS.R.value * T)) * (1 + 0.025 * g.normal()), 4)]);
      }
      return table(['T (K)', 'k (1/s)'], rows);
    }
  },
  {
    id: 'diode', label: 'Diode I\u2013V',
    equation: 'I(V) = I0*(exp(V/(n*Vt)) - 1)', fixed: { Vt: PHYSICAL_CONSTANTS.Vt.value },
    make() {
      const g = seeded(17);
      const rows = [];
      for (let i = 0; i <= 16; i++) {
        const V = 0.3 + i * 0.025;
        const I = 2.1e-9 * (Math.exp(V / (1.72 * PHYSICAL_CONSTANTS.Vt.value)) - 1);
        rows.push([round(V, 4), round(I * (1 + 0.02 * g.normal()), 4)]);
      }
      return table(['V (V)', 'I (A)'], rows);
    }
  },
  {
    id: 'damped', label: 'Damped oscillation',
    equation: 'x = A*exp(-t/tau)*cos(2*pi*t/P + phi) + x0', bounds: { P: { min: 0 }, tau: { min: 0 } },
    make() {
      const g = seeded(19);
      const rows = [];
      for (let i = 0; i < 120; i++) {
        const t = i * 0.05;
        rows.push([round(t, 3), round(2.4 * Math.exp(-t / 2.2) * Math.cos(2 * Math.PI * t / 1.15 + 0.6) + 0.15 + 0.05 * g.normal(), 4)]);
      }
      return table(['t (s)', 'x (mm)'], rows);
    }
  },
  {
    id: 'surface', label: 'Two variables',
    equation: 'z = a*x + b*y + c',
    make() {
      const g = seeded(23);
      const rows = [];
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) rows.push([i, j * 0.5, round(1.5 * i - 0.7 * j * 0.5 + 2 + 0.08 * g.normal(), 4)]);
      return table(['x', 'y', 'z'], rows);
    }
  }
];

/* ------------------------------------------------------------------ *
 * Numbers
 * ------------------------------------------------------------------ */

/**
 * A number to `digits` significant figures, as short as it can be:
 * 1.5, 0.00123, 1.30243e+7. Exponents are used below 1e-4 and from 1e6.
 */
export function fmt(v, digits = 6) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  if (v === Infinity) return '\u221e';
  if (v === -Infinity) return '\u2212\u221e';
  if (v === 0) return '0';
  const a = Math.abs(v);
  let s;
  if (a < 1e-4 || a >= 1e6) {
    s = v.toExponential(digits - 1).replace(/\.?0+e/, 'e');
  } else {
    s = String(Number(v.toPrecision(digits)));
  }
  return s;
}

/** The same number with a real minus sign and 10ⁿ as HTML. */
export function fmtHtml(v, digits = 6) {
  const s = fmt(v, digits);
  const m = /^(-?)([\d.]+)e([+-])(\d+)$/.exec(s);
  if (!m) return s.replace(/^-/, '\u2212');
  return `${m[1] ? '\u2212' : ''}${m[2]}\u2009\u00d7\u200910<sup>${m[3] === '-' ? '\u2212' : ''}${m[4]}</sup>`;
}

/**
 * A value and its standard error as they are reported: the error to two
 * significant figures and the value to the same decimal place, so that no
 * digit is shown that the uncertainty makes meaningless. Very large or small
 * numbers share one power of ten: `(1.235 ± 0.034) × 10⁻⁷`.
 *
 * @param {number} v
 * @param {number} se - a finite, positive standard error
 * @returns {{value: string, error: string, exponent: number, decimals: number}}
 *   `value` and `error` are the mantissas when `exponent` is not 0.
 */
export function roundToError(v, se) {
  const place = Math.floor(Math.log10(se)) - 1;
  const top = Math.floor(Math.log10(Math.max(Math.abs(v), se)));
  const exponent = top >= 6 || top <= -5 ? top : 0;
  const decimals = Math.max(0, exponent - place);
  const step = 10 ** place;
  const scale = 10 ** exponent;
  const show = x => (Math.round(x / step) * step / scale).toFixed(decimals).replace(/^-(?=0(\.0*)?$)/, '');
  return { value: show(v), error: show(se), exponent, decimals };
}

/** A value ± its standard error as HTML, rounded by `roundToError`. */
function valueWithErrorHtml(v, se) {
  // An error a millionth of the value or less (an exact fit) would need a
  // dozen decimals; the plain form says the same more briefly.
  if (!Number.isFinite(v) || !(se > 0) || !Number.isFinite(se) || se < 1e-6 * Math.abs(v)) {
    return `${fmtHtml(v)}<span class="cf-pm">±</span>${fmtHtml(se, 3)}`;
  }
  const r = roundToError(v, se);
  const minus = s => s.replace(/^-/, '−');
  const pair = `${minus(r.value)}<span class="cf-pm">±</span>${r.error}`;
  if (!r.exponent) return pair;
  return `(${pair}) × 10<sup>${minus(String(r.exponent))}</sup>`;
}

/** The same number as LaTeX. */
export function fmtTex(v, digits = 6) {
  const s = fmt(v, digits);
  if (s === 'n/a') return '\\text{n/a}';
  if (s === '\u221e') return '\\infty';
  const m = /^(-?)([\d.]+)e([+-])(\d+)$/.exec(s);
  if (!m) return s;
  return `${m[1]}${m[2]} \\times 10^{${m[3] === '-' ? '-' : ''}${m[4]}}`;
}

/** Parse what someone typed into a number box: '' → null, '1,5' → 1.5. */
export function readNumber(text) {
  const s = String(text ?? '').trim().replace(/\u2212/g, '-').replace(/^([+-]?\d+),(\d+)$/, '$1.$2');
  if (s === '') return null;
  if (!NUMBER_RE.test(s) && !/^[+-]?inf(inity)?$/i.test(s)) return NaN;
  if (/inf/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  return Number(s.replace(/[dD]/, 'e'));
}

/* ------------------------------------------------------------------ *
 * The fitted equation with numbers in it
 * ------------------------------------------------------------------ */

function numberNode(value, digits) {
  return { type: 'number', value, raw: fmt(value, digits) };
}

/* A leading factor that is a negative number, as in -2*x or -2/x. */
function negativeLead(node) {
  if (node.type === 'number') return node.value < 0;
  if (node.type === 'binary' && (node.op === '*' || node.op === '/')) return negativeLead(node.left);
  return false;
}

function negateLead(node) {
  if (node.type === 'number') return { ...node, value: -node.value, raw: String(node.raw ?? node.value).replace(/^-/, '') };
  return { ...node, left: negateLead(node.left) };
}

/**
 * The equation's right side with parameter values in place of their names,
 * and `a + -2*x` written as `a - 2*x`.
 *
 * @param {object} ast
 * @param {Object<string, number>} values
 * @param {number} [digits=6]
 * @returns {object}
 */
export function substitute(ast, values, digits = 6) {
  const walk = node => {
    switch (node.type) {
      case 'symbol':
        return Object.hasOwn(values, node.name) && Number.isFinite(values[node.name])
          ? numberNode(values[node.name], digits) : node;
      case 'unary': {
        const arg = walk(node.arg);
        if (node.op === '-' && arg.type === 'number') return { ...arg, value: -arg.value, raw: fmt(-arg.value, digits) };
        return { ...node, arg };
      }
      case 'binary': {
        const left = walk(node.left);
        let right = walk(node.right);
        let op = node.op;
        if ((op === '+' || op === '-') && negativeLead(right)) {
          right = negateLead(right);
          op = op === '+' ? '-' : '+';
        }
        return { ...node, op, left, right };
      }
      case 'call':
        return { ...node, args: node.args.map(walk) };
      default:
        return node;
    }
  };
  return walk(ast);
}


/* ------------------------------------------------------------------ *
 * Python colouring
 * ------------------------------------------------------------------ */

const PY_KEYWORDS = new Set(('False None True and as assert break class continue def del elif else except ' +
  'finally for from global if import in is lambda nonlocal not or pass raise return try while with yield').split(' '));

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The script as HTML with comments, strings, keywords and numbers wrapped in
 * spans. Every character is kept, so the element's textContent is the script.
 *
 * @param {string} code
 * @returns {string}
 */
export function highlightPython(code) {
  const n = code.length;
  const span = (cls, text) => `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
  const isId = ch => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
  let out = '';
  let plain = '';
  const flush = () => { if (plain) { out += escapeHtml(plain); plain = ''; } };
  let i = 0;
  while (i < n) {
    const ch = code[i];
    if (ch === '#') {
      let j = code.indexOf('\n', i);
      if (j < 0) j = n;
      flush();
      out += span('c', code.slice(i, j));
      i = j;
      continue;
    }
    const prev = code[i - 1];
    if (!isId(prev)) {
      const m = /^(?:[rRbBuUfF]{1,2})?("""|'''|"|')/.exec(code.slice(i, i + 5));
      if (m) {
        const quote = m[1];
        const raw = /[rR]/.test(m[0].slice(0, -quote.length));
        let j = i + m[0].length;
        if (quote.length === 3) {
          const k = code.indexOf(quote, j);
          j = k < 0 ? n : k + 3;
        } else {
          while (j < n && code[j] !== quote && code[j] !== '\n') j += code[j] === '\\' && !raw ? 2 : 1;
          if (code[j] === quote) j++;
        }
        flush();
        out += span('s', code.slice(i, j));
        i = j;
        continue;
      }
      if (/\d/.test(ch) || (ch === '.' && /\d/.test(code[i + 1] || ''))) {
        const m2 = /^(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?j?/.exec(code.slice(i, i + 40));
        flush();
        out += span('n', m2[0]);
        i += m2[0].length;
        continue;
      }
      if (isId(ch)) {
        let j = i;
        while (j < n && isId(code[j])) j++;
        const word = code.slice(i, j);
        if (PY_KEYWORDS.has(word)) { flush(); out += span('k', word); }
        else plain += word;
        i = j;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => startPage());
  else startPage();
}

function startPage() {
  const $ = id => document.getElementById(id);
  const ui = {
    example: $('cfExample'), reset: $('cfReset'), toasts: $('cfToasts'), live: $('cfLive'),
    dataPanel: $('cfData'), openFile: $('cfOpenFile'), clearData: $('cfClearData'), file: $('cfFile'),
    drop: $('cfDrop'), dataText: $('cfDataText'), samples: $('cfSamples'), dataOk: $('cfDataOk'),
    dataStats: $('cfDataStats'), columns: $('cfColumns'), dataIssues: $('cfDataIssues'),
    eq: $('cfEq'), eqMirror: $('cfEqMirror'), eqTex: $('cfEqTex'), eqMsg: $('cfEqMsg'), eqNotes: $('cfEqNotes'),
    fnList: $('cfFnList'), presets: $('cfPresets'),
    varsGroup: $('cfVarsGroup'), pickVar: $('cfPickVar'), vars: $('cfVars'), absWrap: $('cfAbsWrap'), abs: $('cfAbsSigma'),
    paramsGroup: $('cfParamsGroup'), params: $('cfParams'), useFitted: $('cfUseFitted'), constants: $('cfConstants'),
    modelOk: $('cfModelOk'),
    status: $('cfStatus'), fitNow: $('cfFitNow'), resultsEmpty: $('cfResultsEmpty'), bigNote: $('cfBigNote'),
    failure: $('cfFailure'), resultBody: $('cfResultBody'), fittedTex: $('cfFittedTex'), paramRows: $('cfParamRows'),
    stats: $('cfStats'), warnings: $('cfWarnings'), corr: $('cfCorr'), corrBadge: $('cfCorrBadge'), corrTable: $('cfCorrTable'),
    theory: $('cfTheory'), theoryBody: $('cfTheoryBody'),
    plotSection: $('cfPlot'), size: $('cfSize'), plotEmpty: $('cfPlotEmpty'), figure: $('cfFigure'), plotNotes: $('cfPlotNotes'),
    plotDrawn: $('cfPlotDrawn'), tryExample: $('cfTryExample'),
    styleHost: $('cfStyleHost'),
    workspace: $('cfWorkspace'), bar: $('cfBar'), barFit: $('cfBarFit'), rail: $('cfRail'),
    tabs: Array.from(document.querySelectorAll('#cfRail [role="tab"]')),
    tabDataInfo: $('cfTabDataInfo'), tabModelInfo: $('cfTabModelInfo'), modelEmpty: $('cfModelEmpty'),
    modelsBtn: $('cfModelsBtn'), modelsMenu: $('cfModelsMenu'), modelsFind: $('cfModelsFind'), modelsNone: $('cfModelsNone'),
    fnBtn: $('cfFnBtn'), fnMenu: $('cfFnMenu'),
    quickResid: $('cfQuickResid'), quickBand: $('cfQuickBand'), quickBandWrap: $('cfQuickBandWrap'), editStyle: $('cfEditStyle'),
    pyName: $('cfPyName'), pyCopy: $('cfPyCopy'), pyDownload: $('cfPyDownload'), pyCode: $('cfPyCode'),
    srcEmbed: $('cfSrcEmbed'), srcCsv: $('cfSrcCsv'), csvOpts: $('cfCsvOpts'), csvName: $('cfCsvName'),
    csvDownload: $('cfCsvDownload'), pyTaken: $('cfPyTaken'), pyFoot: $('cfPyFoot')
  };

  const STORE_KEY = 'stemkit.curve-fitter';
  const STORE_VERSION = 1;
  const MAX_STORED_DATA = 200 * 1024;
  const AUTO_FIT_ROWS = 20000;
  const EMBED_ROWS = 2000;
  const SIGMA = '\u03c3';

  const state = {
    dataText: '',
    dataName: '',
    table: parseTable(''),
    dataVersion: 0,
    sample: null,
    eqText: '',
    eq: null,
    roles: {},
    asParameters: [],
    noVariable: false,
    chosen: {},
    params: {},
    absoluteSigma: false,
    style: defaultPlotStyle(),
    autoLabels: null,
    pySource: null,
    csvName: 'data.csv',
    model: null,
    fit: null,
    fitSpec: null,
    fitKey: '',
    pyText: ''
  };

  /* ---------------- small helpers ---------------- */

  const esc = escapeHtml;
  const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

  function katexHtml(latex, display = false) {
    if (!window.katex) return `<span class="cf-mono">${esc(latex)}</span>`;
    try {
      return window.katex.renderToString(latex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });
    } catch (e) {
      return `<span class="cf-mono">${esc(latex)}</span>`;
    }
  }
  const nameHtml = name => katexHtml(symbolToLatex(name));

  function toast(message, kind = '', action = null) {
    const t = document.createElement('div');
    t.className = 'stk-toast' + (kind ? ` stk-toast-${kind}` : '');
    t.setAttribute('role', 'status');
    const icon = kind === 'danger' ? 'fa-circle-exclamation' : kind === 'ok' ? 'fa-circle-check' : kind === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info';
    t.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span></span>`;
    t.querySelector('span').textContent = message;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'stk-btn stk-btn-sm';
      b.textContent = action.label;
      b.addEventListener('click', () => { action.run(); t.remove(); });
      t.appendChild(b);
    }
    ui.toasts.appendChild(t);
    setTimeout(() => t.remove(), action ? 8000 : 3200);
  }

  let announceTimer = null;
  function announce(text) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { ui.live.textContent = text; }, 400);
  }

  function copyText(text, done) {
    const ok = () => { if (done) done(); };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { toast('Copy failed. Select the text and copy it by hand.', 'danger'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok).catch(fallback);
    else fallback();
  }

  function flashCopied(btn) {
    if (!btn) return;
    const html = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> Copied';
    btn.setAttribute('aria-pressed', 'true');
    setTimeout(() => { btn.innerHTML = html; btn.removeAttribute('aria-pressed'); }, 1600);
  }

  function download(text, filename, type = 'text/plain') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function debounce(fn, ms) {
    let t = null;
    const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    d.cancel = () => clearTimeout(t);
    return d;
  }

  /* Re-render a container without losing the focused control inside it. */
  function keepFocus(container, render) {
    const active = document.activeElement;
    const key = active && container.contains(active) ? active.getAttribute('data-key') : null;
    const sel = key && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    render();
    if (key) {
      const again = container.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (again) {
        again.focus({ preventScroll: true });
        if (sel && typeof again.setSelectionRange === 'function') {
          try { again.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ }
        }
      }
    }
  }

  /* ---------------- the workspace: tabs, menus, the equation bar ---------------- */

  const TAB_KEY = 'stemkit.curve-fitter.tab';
  // Below this width the workspace stacks and nothing is pinned.
  const narrow = window.matchMedia('(max-width: 1023.98px)');

  /*
   * The inputs are three tabs beside the outputs. The chosen one is
   * remembered; arrow keys move between tabs as the ARIA pattern has it.
   */
  function selectTab(name, { focus = false, reveal = false } = {}) {
    ui.tabs.forEach(t => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) t.focus();
    });
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* storage blocked */ }
    if (reveal && narrow.matches) ui.rail.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  ui.tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t.dataset.tab));
    t.addEventListener('keydown', e => {
      const n = ui.tabs.length;
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1 + n, Home: 0, End: n - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      selectTab(ui.tabs[to % n].dataset.tab, { focus: true });
    });
  });

  /* Each tab says how far it has got: done, needs attention, or not yet. */
  function syncTabs() {
    const t = state.table;
    const m = state.model;
    const hasData = t.rows >= 2 && t.columns.length >= 1;
    const eqBad = !!(state.eq && !state.eq.ok);
    const modelDone = !!(m && m.ready);
    const modelNeeds = eqBad || !!(m && hasData && (m.needVariable || m.problems.some(p => p.startsWith('column:') || p === 'parameters')));
    const [tabData, tabModel] = ui.tabs;
    tabData.setAttribute('data-stk-state', hasData ? 'done' : 'current');
    tabModel.setAttribute('data-stk-state', modelDone ? 'done' : hasData ? 'current' : 'pending');
    tabModel.classList.toggle('cf-tab-alert', modelNeeds);
    ui.tabDataInfo.textContent = hasData ? t.rows.toLocaleString('en-GB') : '';
    ui.tabModelInfo.textContent = m && m.parameters.length ? String(m.parameters.length) : '';
    ui.tabDataInfo.title = hasData ? `${plural(t.rows, 'row')} of data` : '';
    ui.tabModelInfo.title = m ? `${plural(m.parameters.length, 'parameter')} to fit` : '';
    ui.modelEmpty.hidden = !(ui.varsGroup.hidden && ui.paramsGroup.hidden);
  }

  /* The Models and f(x) menus: one open at a time, closed by Escape or a click outside. */
  const menus = [[ui.modelsBtn, ui.modelsMenu], [ui.fnBtn, ui.fnMenu]];
  function closeMenus(returnFocus = false) {
    menus.forEach(([btn, menu]) => {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (returnFocus) btn.focus();
    });
  }
  menus.forEach(([btn, menu]) => {
    btn.addEventListener('click', () => {
      const open = menu.hidden;
      closeMenus();
      if (!open) return;
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      if (menu === ui.modelsMenu) { ui.modelsFind.value = ''; filterModels(); ui.modelsFind.focus(); } else {
        const first = menu.querySelector('button');
        if (first) first.focus();
      }
    });
    menu.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeMenus(true); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.from(menu.querySelectorAll('button')).filter(b => !b.hidden && !b.closest('[hidden]'));
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
      items[next].focus();
    });
  });
  document.addEventListener('click', e => {
    if (!menus.some(([btn, menu]) => btn.contains(e.target) || menu.contains(e.target))) closeMenus();
  });
  document.addEventListener('focusin', e => {
    if (!menus.some(([btn, menu]) => btn.contains(e.target) || menu.contains(e.target))) closeMenus();
  });

  function filterModels() {
    const q = ui.modelsFind.value.trim().toLowerCase();
    let shown = 0;
    ui.presets.querySelectorAll('.cf-menu-group').forEach(g => {
      let any = false;
      g.querySelectorAll('[data-preset]').forEach(b => {
        const hit = !q || b.textContent.toLowerCase().includes(q) || g.getAttribute('aria-label').toLowerCase().includes(q);
        b.hidden = !hit;
        if (hit) { any = true; shown++; }
      });
      g.hidden = !any;
    });
    ui.modelsNone.hidden = shown > 0;
  }
  ui.modelsFind.addEventListener('input', filterModels);
  ui.modelsFind.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const first = ui.presets.querySelector('[data-preset]:not([hidden])');
    if (first && !first.closest('[hidden]')) { e.preventDefault(); first.click(); }
  });

  // The bar pins under the site header and the rail under the bar, so both
  // heights are passed to the stylesheet as they change.
  const siteHeader = document.querySelector('nav[aria-label="Site"]');
  const headHeight = () => (siteHeader ? Math.round(siteHeader.getBoundingClientRect().height) : 0);
  const measureBar = () => {
    ui.workspace.style.setProperty('--cf-head', `${headHeight()}px`);
    ui.workspace.style.setProperty('--cf-bar', `${Math.round(ui.bar.getBoundingClientRect().height)}px`);
  };
  if ('ResizeObserver' in window) new ResizeObserver(measureBar).observe(ui.bar);
  window.addEventListener('resize', debounce(measureBar, 100));
  measureBar();

  // Once pinned, the bar keeps the equation and its typeset form but drops the notes.
  const barMark = document.createElement('div');
  barMark.className = 'cf-bar-mark';
  barMark.setAttribute('aria-hidden', 'true');
  ui.workspace.before(barMark);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      ui.bar.classList.toggle('is-stuck', !narrow.matches && !entry.isIntersecting && entry.boundingClientRect.top < headHeight());
    }, { rootMargin: `-${headHeight() + 1}px 0px 0px 0px` }).observe(barMark);
  }

  /* ---------------- step 1: data ---------------- */

  const parseDataSoon = debounce(() => applyData(), 180);

  function setData(text, name = '') {
    state.dataText = text;
    state.dataName = name;
    if (ui.dataText.value !== text) ui.dataText.value = text;
    applyData();
  }

  function applyData() {
    state.dataText = ui.dataText.value;
    state.table = parseTable(state.dataText);
    state.dataVersion++;
    renderData();
    refreshModel();
    scheduleFit(state.table.rows > 5000 ? 250 : 60);
    save();
  }

  function columnRange(values) {
    let lo = Infinity;
    let hi = -Infinity;
    let count = 0;
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      count++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return { lo, hi, count };
  }

  function renderData() {
    const t = state.table;
    const hasText = state.dataText.trim() !== '';
    ui.drop.hidden = hasText;
    ui.clearData.hidden = !hasText;
    ui.dataOk.hidden = !(t.rows >= 2 && t.columns.length >= 1);
    if (!ui.dataOk.hidden) {
      const bits = [
        `<b>${t.rows.toLocaleString('en-GB')}</b> rows`,
        `<b>${t.columns.length}</b> column${t.columns.length === 1 ? '' : 's'}`,
        DELIMITER_NAMES[t.delimiter] + (t.decimalComma ? ', decimal commas' : ''),
        t.header ? 'column names from the header' : 'no header row'
      ];
      if (state.dataName) bits.unshift(`<span class="cf-mono">${esc(clip(state.dataName, 28))}</span>`);
      ui.dataStats.innerHTML = bits.join(', ');
      renderColumnList();
    }
    const problems = [...t.skipped.map(s => ({ ...s, skipped: true })), ...t.issues].sort((a, b) => a.line - b.line);
    if (hasText && (problems.length || t.notes.length || (t.rows < 2 && t.rows >= 0))) {
      const items = [];
      if (t.rows < 2) items.push(t.rows === 0 ? 'No rows of numbers found yet.' : 'Only one row of numbers: a fit needs at least two.');
      t.notes.forEach(n => items.push(n));
      problems.slice(0, 5).forEach(p => items.push(`Line ${p.line}: ${p.reason}${p.skipped ? ', skipped' : ''}.`));
      if (problems.length > 5) items.push(`${problems.length - 5} more line${problems.length - 5 === 1 ? '' : 's'} like these.`);
      if (t.issues.length) items.push('Rows with a missing value are left out of the fit when that column is used.');
      ui.dataIssues.innerHTML = `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><ul class="cf-issue-list">${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
      ui.dataIssues.hidden = false;
    } else {
      ui.dataIssues.hidden = true;
    }
    ui.samples.querySelectorAll('.cf-chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.sample === state.sample)));
  }

  /* The columns, each with the variable that reads it. */
  function renderColumnList() {
    const t = state.table;
    const uses = new Map();
    const m = state.model;
    if (m && m.map) {
      for (const [name, k] of Object.entries(m.map.columns)) if (k >= 0) uses.set(k, name);
      if (m.map.sigma !== null && m.map.sigma !== undefined) uses.set(m.map.sigma, SIGMA);
    }
    const shown = t.columns.slice(0, 12);
    ui.columns.innerHTML = shown.map((c, k) => {
      const r = columnRange(c.values);
      const range = r.count ? `${fmt(r.lo, 4)} \u2026 ${fmt(r.hi, 4)}` : 'no numbers';
      const label = c.label && c.label !== c.name ? `<span class="cf-col-label" title="${esc(c.label)}">\u201c${esc(c.label)}\u201d</span>` : `<span class="cf-col-label">column ${k + 1}</span>`;
      const use = uses.has(k) ? `<span class="cf-col-use" title="Read as ${esc(uses.get(k))}">\u2192 ${esc(uses.get(k))}</span>` : '';
      return `<li><span class="cf-col-id">${esc(c.name)}</span>${label}${use}<span class="cf-col-range">${esc(range)}</span></li>`;
    }).join('') + (t.columns.length > shown.length ? `<li>and ${t.columns.length - shown.length} more</li>` : '');
  }

  ui.dataText.addEventListener('input', () => {
    state.sample = null;
    state.dataName = '';
    parseDataSoon();
  });
  ui.clearData.addEventListener('click', () => {
    state.sample = null;
    setData('');
    ui.dataText.focus();
  });
  ui.openFile.addEventListener('click', () => ui.file.click());
  ui.file.addEventListener('change', () => {
    const f = ui.file.files && ui.file.files[0];
    if (f) readFile(f);
    ui.file.value = '';
  });

  function readFile(file) {
    if (file.size > 50 * 1024 * 1024) {
      toast(`${file.name} is larger than 50 MB; open a smaller file or a part of it.`, 'danger');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.sample = null;
      setData(String(reader.result || ''), file.name);
      const base = file.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'data';
      state.csvName = `${base}_fit.csv`;
      ui.csvName.value = state.csvName;
      toast(`Loaded ${file.name}: ${plural(state.table.rows, 'row')}.`, 'ok');
    };
    reader.onerror = () => toast(`Could not read ${file.name}.`, 'danger');
    reader.readAsText(file);
  }

  // Drop a file anywhere on the workspace; the data tab comes forward to take it.
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  ui.workspace.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!dragDepth) selectTab('data');
    dragDepth++;
    ui.dataPanel.classList.add('is-over');
    ui.drop.classList.add('is-over');
  });
  ui.workspace.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  ui.workspace.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) { ui.dataPanel.classList.remove('is-over'); ui.drop.classList.remove('is-over'); }
  });
  ui.workspace.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    ui.dataPanel.classList.remove('is-over');
    ui.drop.classList.remove('is-over');
    const f = e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  /* Samples */
  ui.samples.innerHTML = SAMPLES.map(s => `<button type="button" class="cf-chip" data-sample="${s.id}" aria-pressed="false">${esc(s.label)}</button>`).join('');
  ui.samples.addEventListener('click', e => {
    const b = e.target.closest('[data-sample]');
    if (b) loadSample(b.dataset.sample);
  });

  function loadSample(id) {
    const s = SAMPLES.find(x => x.id === id);
    if (!s) return;
    state.roles = {};
    state.asParameters = [];
    state.noVariable = false;
    state.chosen = {};
    state.absoluteSigma = !!s.absoluteSigma;
    ui.abs.checked = state.absoluteSigma;
    state.csvName = `${s.id}.csv`;
    ui.csvName.value = state.csvName;
    // A sample is a fresh start: its axis labels come from its own columns.
    state.style = { ...state.style, xLabel: '', yLabel: '' };
    state.autoLabels = null;
    setEquationText(s.equation, { bounds: s.bounds, fixed: s.fixed, reset: true, silent: true });
    state.sample = id;
    setData(s.make(), '');
    state.sample = id;
    renderData();
  }

  /* ---------------- step 2: the equation ---------------- */

  ui.presets.innerHTML = PRESET_GROUPS.map(([group, ids]) =>
    `<div class="cf-menu-group" role="group" aria-label="${esc(group)}"><p class="cf-menu-gt" aria-hidden="true">${esc(group)}</p>` +
    ids.map(id => PRESETS.find(p => p.id === id)).filter(Boolean).map(p =>
      `<button type="button" class="cf-menu-item" data-preset="${p.id}" aria-pressed="false">` +
      `<span class="cf-mi-name">${esc(p.label)}</span><span class="cf-mi-eq">${esc(presetEquation(p).text)}</span></button>`).join('') +
    '</div>').join('');
  ui.presets.addEventListener('click', e => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    closeMenus();
    const p = PRESETS.find(x => x.id === b.dataset.preset);
    const r = presetEquation(p, currentNames());
    state.roles = { [r.x]: 'variable' };
    state.noVariable = false;
    const fixed = { ...(p.fixed || {}) };
    setEquationText(r.text, { bounds: p.bounds, fixed, start: null, reset: true });
    ui.eq.focus();
  });

  /* The person's own names for x and y, to write presets in. */
  function currentNames() {
    const m = state.model;
    if (m && m.independent.length === 1 && !m.virtual) return { x: m.independent[0], y: m.dependent };
    const cols = state.table.columns.filter(c => !looksLikeSigma(c));
    if (state.table.header && cols.length >= 2) return { x: cols[0].name, y: cols[1].name };
    return {};
  }

  // Functions and constants to insert.
  const fnItems = Object.entries(FUNCTIONS).filter(([, f]) => !f.aliasOf).map(([name, f]) => {
    const arity = Array.isArray(f.arity) ? f.arity[0] : f.arity;
    const args = arity === 2 ? (name === 'atan2' ? 'y, x' : 'a, b') : 'x';
    return { insert: `${name}()`, label: `${name}(${args})`, title: f.description };
  });
  Object.entries(CONSTANTS).forEach(([name, c]) => fnItems.push({ insert: name, label: name, title: c.description }));
  ui.fnList.innerHTML = fnItems.map((f, i) => `<button type="button" class="cf-fn" data-fn="${i}" title="${esc(f.title)}">${esc(f.label)}</button>`).join('');
  ui.fnList.addEventListener('click', e => {
    const b = e.target.closest('[data-fn]');
    if (!b) return;
    const f = fnItems[Number(b.dataset.fn)];
    const el = ui.eq;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const selected = el.value.slice(start, end);
    const text = f.insert.endsWith('()') ? `${f.insert.slice(0, -1)}${selected})` : f.insert;
    el.focus();
    el.setRangeText(text, start, end, 'end');
    if (f.insert.endsWith('()') && !selected) el.setSelectionRange(start + text.length - 1, start + text.length - 1);
    closeMenus(false);
    onEquationInput();
  });

  function setEquationText(text, opts = {}) {
    ui.eq.value = text;
    state.eqText = text;
    if (opts.reset) {
      const eq = parseEquation(text);
      if (eq.ok) {
        for (const name of symbolsOf(eq.ast).identifiers) {
          const s = {};
          if (opts.bounds && opts.bounds[name]) {
            if (opts.bounds[name].min !== undefined) s.min = String(opts.bounds[name].min);
            if (opts.bounds[name].max !== undefined) s.max = String(opts.bounds[name].max);
          }
          if (opts.fixed && Object.hasOwn(opts.fixed, name)) { s.initial = String(opts.fixed[name]); s.fixed = true; }
          if (opts.start && Object.hasOwn(opts.start, name)) s.initial = String(opts.start[name]);
          state.params[name] = s;
        }
      }
    }
    if (opts.reset) paramSignature = '';
    autoGrow();
    refreshModel();
    if (!opts.silent) scheduleFit(0);
    save();
  }

  function autoGrow() {
    ui.eq.style.height = 'auto';
    ui.eq.style.height = `${ui.eq.scrollHeight + 2}px`;
  }

  function onEquationInput() {
    const clean = ui.eq.value.replace(/\s*[\r\n]+\s*/g, ' ');
    if (clean !== ui.eq.value) {
      const pos = ui.eq.selectionStart;
      ui.eq.value = clean;
      ui.eq.setSelectionRange(Math.min(pos, clean.length), Math.min(pos, clean.length));
    }
    state.eqText = ui.eq.value;
    autoGrow();
    refreshModel();
    scheduleFit(state.table.rows > 5000 ? 450 : 220);
    save();
  }
  ui.eq.addEventListener('input', onEquationInput);
  ui.eq.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFit(false);
    }
  });
  window.addEventListener('resize', debounce(autoGrow, 100));

  function refreshModel() {
    const text = state.eqText;
    state.eq = text.trim() ? parseEquation(text) : null;
    state.model = deriveModel();
    renderEquation();
    renderVariables();
    renderParams();
    renderConstants();
    if (!ui.dataOk.hidden) renderColumnList();
    ui.modelOk.hidden = !(state.model && state.model.ready);
    ui.presets.querySelectorAll('[data-preset]').forEach(c => {
      const p = PRESETS.find(x => x.id === c.dataset.preset);
      const r = presetEquation(p, currentNames());
      c.setAttribute('aria-pressed', String(r.text.replace(/\s+/g, '') === text.replace(/\s+/g, '')));
    });
    updateStyleContext();
    syncTabs();
    if (syncLabels()) schedulePython();
  }

  /*
   * Everything the fit needs to know about the equation and the data: the
   * variables and their columns, the parameters, and what still stops it.
   */
  function deriveModel() {
    const eq = state.eq;
    if (!eq || !eq.ok) return null;
    const cols = state.table.columns;
    const roles = resolveRoles(eq, cols, state.roles, state.asParameters);
    let independent = roles.independent;
    let virtual = null;
    const needVariable = !independent.length;
    if (needVariable && (state.noVariable || !roles.names.length)) {
      // A constant model: the points are still drawn against a column.
      virtual = ['x', 't', 'n', 'x_1', 'x_2'].find(n => !roles.names.includes(n) && n !== roles.dependent) || 'x_0';
      independent = [virtual];
    }
    const map = mapColumns(independent, roles.dependent, cols, state.chosen);
    const problems = [];
    if (state.table.rows < 2) problems.push('data');
    if (!independent.length) problems.push('variable');
    for (const v of [...independent, roles.dependent]) if (!Object.hasOwn(map.columns, v)) problems.push(`column:${v}`);
    if (!roles.parameters.length) problems.push('parameters');
    return {
      ...roles,
      independent,
      virtual,
      needVariable: needVariable && !virtual,
      map,
      problems,
      ready: problems.length === 0,
      multivariate: independent.length > 1
    };
  }

  function renderEquation() {
    const eq = state.eq;
    const text = state.eqText;
    const mirror = ui.eqMirror;
    if (!eq) {
      mirror.textContent = '';
      ui.eq.removeAttribute('aria-invalid');
      ui.eqMsg.hidden = true;
      ui.eqNotes.hidden = true;
      ui.eqTex.hidden = true;
      return;
    }
    if (!eq.ok) {
      const { start, end, message } = eq.error;
      const a = Math.max(0, Math.min(start, text.length));
      const b = Math.max(a, Math.min(end, text.length));
      const marked = a === b ? `<mark>${esc(text.slice(a, a + 1) || ' ')}</mark>${esc(text.slice(a + 1))}` : `<mark>${esc(text.slice(a, b))}</mark>${esc(text.slice(b))}`;
      mirror.innerHTML = esc(text.slice(0, a)) + marked;
      ui.eq.setAttribute('aria-invalid', 'true');
      const said = /[.?!]$/.test(message) ? message : `${message}.`;
      ui.eqMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><span>${esc(said)}</span>`;
      ui.eqMsg.hidden = false;
      ui.eqTex.hidden = true;
      ui.eqNotes.hidden = true;
      return;
    }
    mirror.textContent = text;
    ui.eq.removeAttribute('aria-invalid');
    ui.eqMsg.hidden = true;
    const m = state.model;
    const lhs = eq.dependent ? '' : `${symbolToLatex('y')} = `;
    ui.eqTex.innerHTML = katexHtml(lhs + toLatex(eq), true);
    ui.eqTex.classList.remove('is-stale');
    ui.eqTex.hidden = false;
    const notes = [...eq.notes];
    const items = notes.map(n => `<p class="cf-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>${esc(n)}</span></p>`);
    if (m) {
      const eNote = m.notes.find(n => n.startsWith("'e'"));
      if (eNote) {
        items.push(`<p class="cf-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>${esc(eNote)} <button type="button" class="stk-btn stk-btn-sm cf-mini" data-act="fit-e">Fit e as a parameter</button></span></p>`);
      }
      if (state.asParameters.includes('e') && m.parameters.includes('e')) {
        items.push(`<p class="cf-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>'e' is fitted as a parameter. <button type="button" class="stk-btn stk-btn-sm cf-mini" data-act="euler">Read e as Euler's number</button></span></p>`);
      }
    }
    ui.eqNotes.innerHTML = items.join('');
    ui.eqNotes.hidden = !items.length;
  }
  ui.eqNotes.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'fit-e') state.asParameters = [...new Set([...state.asParameters, 'e'])];
    if (b.dataset.act === 'euler') state.asParameters = state.asParameters.filter(n => n !== 'e');
    refreshModel();
    scheduleFit(0);
    save();
  });

  function columnOptions(selected, { rowNumber = false, none = false } = {}) {
    const opts = [];
    if (none) opts.push(`<option value="none"${selected === null ? ' selected' : ''}>None</option>`);
    state.table.columns.forEach((c, k) => {
      const label = c.label && c.label !== c.name ? `${c.name}: ${c.label}` : c.label ? c.name : `${c.name} (column ${k + 1})`;
      opts.push(`<option value="${k}"${selected === k ? ' selected' : ''}>${esc(clip(label, 40))}</option>`);
    });
    if (rowNumber) opts.push(`<option value="${ROW_NUMBER}"${selected === ROW_NUMBER ? ' selected' : ''}>Row number (1, 2, 3, \u2026)</option>`);
    return opts.join('');
  }

  /*
   * While the equation is being typed it is often briefly unreadable (an
   * open bracket). The variables and parameters of the last reading stay in
   * place, dimmed and out of reach, rather than vanishing and coming back.
   */
  function staleGroups(stale) {
    for (const g of [ui.varsGroup, ui.paramsGroup]) {
      g.classList.toggle('is-stale', stale);
      if (stale) g.setAttribute('inert', '');
      else g.removeAttribute('inert');
    }
  }

  function renderVariables() {
    const m = state.model;
    const typing = !m && state.eq && !state.eq.ok && !ui.varsGroup.hidden;
    staleGroups(!!typing);
    if (typing) return;
    ui.varsGroup.hidden = !m;
    if (!m) return;
    if (m.needVariable) {
      ui.pickVar.innerHTML = '<p>Which name is the measured variable, the one read from a data column?</p>' +
        `<div class="cf-pickvar-list">${m.names.map(n => `<button type="button" class="stk-btn stk-btn-sm" data-var="${esc(n)}">${nameHtml(n)}</button>`).join('')}` +
        '<button type="button" class="stk-btn stk-btn-sm stk-btn-ghost" data-var="">None: the equation is a constant</button></div>';
      ui.pickVar.hidden = false;
    } else {
      ui.pickVar.hidden = true;
    }
    const hasCols = state.table.columns.length > 0;
    keepFocus(ui.vars, () => {
      const rows = [];
      const selectFor = (key, label, value, opts) => hasCols
        ? `<select class="stk-select stk-select-sm" data-key="${esc(key)}" aria-label="${esc(label)}">${columnOptions(value, opts)}</select>`
        : '<span class="stk-hint">Add data on the Data tab</span>';
      const depCol = m.map.columns[m.dependent];
      rows.push(`<div class="cf-var"><span class="cf-var-name"><span class="cf-var-sym">${nameHtml(m.dependent)}</span><span class="cf-var-role">measured values</span></span>` +
        selectFor(`col:${m.dependent}`, `Column for ${m.dependent}, the measured values`, depCol ?? -2, {}) + '<span class="cf-var-act"></span></div>');
      for (const v of m.independent) {
        const act = v === m.virtual
          ? ''
          : `<button type="button" class="stk-btn stk-btn-sm stk-btn-ghost cf-mini" data-act="to-param" data-name="${esc(v)}" title="Fit ${esc(v)} as a parameter instead of reading it from the data">Fit as parameter</button>`;
        const role = v === m.virtual ? 'not in the equation; the x axis' : 'variable';
        rows.push(`<div class="cf-var"><span class="cf-var-name"><span class="cf-var-sym">${nameHtml(v)}</span><span class="cf-var-role">${role}</span></span>` +
          selectFor(`col:${v}`, `Column for the variable ${v}`, m.map.columns[v] ?? -2, { rowNumber: true }) + `<span class="cf-var-act">${act}</span></div>`);
      }
      if (hasCols) {
        rows.push(`<div class="cf-var"><span class="cf-var-name"><span class="cf-var-sym">${katexHtml('\\sigma')}</span><span class="cf-var-role">uncertainty of ${esc(m.dependent)}</span></span>` +
          selectFor(`col:${SIGMA}`, `Column of the uncertainties of ${m.dependent}`, m.map.sigma, { none: true }) + '<span class="cf-var-act"></span></div>');
      }
      ui.vars.innerHTML = rows.join('');
    });
    ui.absWrap.hidden = !(hasCols && m.map.sigma !== null && m.map.sigma !== undefined);
  }

  ui.vars.addEventListener('change', e => {
    const sel = e.target.closest('select[data-key]');
    if (!sel) return;
    const name = sel.dataset.key.slice(4);
    const v = sel.value === 'none' ? null : Number(sel.value);
    state.chosen = { ...state.chosen, [name]: v };
    refreshModel();
    scheduleFit(0);
    save();
  });
  ui.vars.addEventListener('click', e => {
    const b = e.target.closest('[data-act="to-param"]');
    if (!b) return;
    state.roles = { ...state.roles, [b.dataset.name]: 'parameter' };
    refreshModel();
    scheduleFit(0);
    save();
    toast(`${b.dataset.name} is now fitted as a parameter.`);
  });
  ui.pickVar.addEventListener('click', e => {
    const b = e.target.closest('[data-var]');
    if (!b) return;
    if (b.dataset.var) {
      state.roles = { ...state.roles, [b.dataset.var]: 'variable' };
      state.noVariable = false;
    } else {
      state.noVariable = true;
    }
    refreshModel();
    scheduleFit(0);
    save();
  });
  ui.abs.addEventListener('change', () => {
    state.absoluteSigma = ui.abs.checked;
    scheduleFit(0);
    save();
  });

  /* Parameters */
  let paramSignature = '';

  function paramState(name) {
    if (!state.params[name]) state.params[name] = {};
    return state.params[name];
  }

  function renderParams() {
    const m = state.model;
    if (!m && ui.paramsGroup.classList.contains('is-stale')) return;
    ui.paramsGroup.hidden = !m;
    if (!m) { paramSignature = ''; return; }
    const sig = m.parameters.join('\u0000');
    if (sig !== paramSignature) {
      paramSignature = sig;
      keepFocus(ui.params, () => {
        ui.params.innerHTML = m.parameters.map(name => {
          const p = paramState(name);
          const k = esc(name);
          const input = (field, label, placeholder) =>
            `<span><input type="text" inputmode="decimal" class="stk-input" data-key="${field}:${k}" data-field="${field}" data-name="${k}" value="${esc(p[field] ?? '')}" placeholder="${placeholder}" aria-label="${esc(label)}" aria-describedby="cfPmsg-${k}" spellcheck="false" autocomplete="off"></span>`;
          return `<div class="cf-prow" role="listitem" data-name="${k}">` +
            `<span class="cf-pname" title="${k}">${nameHtml(name)}</span>` +
            input('initial', `Starting value of ${name}`, 'auto') +
            input('min', `Lower bound of ${name}`, '\u2212\u221e') +
            input('max', `Upper bound of ${name}`, '\u221e') +
            `<span class="cf-pfix"><input type="checkbox" data-key="fixed:${k}" data-field="fixed" data-name="${k}"${p.fixed ? ' checked' : ''} aria-label="Hold ${k} fixed at its starting value" title="Hold ${k} fixed at its starting value"></span>` +
            `<span><button type="button" class="stk-btn stk-btn-sm stk-btn-ghost stk-btn-icon" data-key="var:${k}" data-act="to-var" data-name="${k}" aria-label="${k} is a variable: read it from a data column" title="${k} is a variable: read it from a data column"><i class="fa-solid fa-table-columns" aria-hidden="true"></i></button></span>` +
            `<p class="stk-error cf-pmsg" id="cfPmsg-${k}" hidden></p><p class="cf-pfound" aria-hidden="true"></p>` +
            '</div>';
        }).join('');
      });
    }
    validateParams();
    renderFoundValues();
  }

  function validateParams() {
    ui.params.querySelectorAll('.cf-prow').forEach(row => {
      const name = row.dataset.name;
      const p = paramState(name);
      const msgs = [];
      const read = f => readNumber(p[f]);
      ['initial', 'min', 'max'].forEach(f => {
        const input = row.querySelector(`[data-field="${f}"]`);
        const v = read(f);
        const bad = Number.isNaN(v);
        input.classList.toggle('is-invalid', bad);
        if (bad) msgs.push(`\u201c${p[f]}\u201d is not a number`);
      });
      const lo = read('min');
      const hi = read('max');
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) msgs.push('the lower bound is above the upper bound');
      const fixed = row.querySelector('[data-field="fixed"]');
      fixed.checked = !!p.fixed;
      if (p.fixed && !Number.isFinite(read('initial'))) msgs.push('give a starting value to hold it at');
      row.querySelectorAll('[data-field="min"], [data-field="max"]').forEach(i => { i.disabled = !!p.fixed; });
      const msg = row.querySelector('.cf-pmsg');
      msg.textContent = msgs.length ? `${msgs.join('; ')}.`.replace(/^./, c => c.toUpperCase()) : '';
      msg.hidden = !msgs.length;
    });
  }

  function renderFoundValues() {
    const f = state.fit && state.fit.ok ? state.fit : null;
    ui.useFitted.disabled = !f;
    ui.params.querySelectorAll('.cf-prow').forEach(row => {
      const out = row.querySelector('.cf-pfound');
      const p = f && f.parameters.find(q => q.name === row.dataset.name);
      out.textContent = p && !p.fixed ? `fitted ${fmt(p.value)}` : '';
    });
  }

  ui.params.addEventListener('input', e => {
    const input = e.target.closest('[data-field]');
    if (!input || input.type === 'checkbox') return;
    paramState(input.dataset.name)[input.dataset.field] = input.value;
    validateParams();
    renderConstants();
    scheduleFit(300);
    save();
  });
  ui.params.addEventListener('change', e => {
    const input = e.target.closest('[data-field="fixed"]');
    if (!input) return;
    const name = input.dataset.name;
    const p = paramState(name);
    p.fixed = input.checked;
    if (p.fixed && !Number.isFinite(readNumber(p.initial))) {
      const found = state.fit && state.fit.ok && state.fit.parameters.find(q => q.name === name);
      if (found && Number.isFinite(found.value)) {
        p.initial = fmt(found.value, 10);
        const box = ui.params.querySelector(`[data-field="initial"][data-name="${CSS.escape(name)}"]`);
        if (box) box.value = p.initial;
      }
    }
    validateParams();
    renderConstants();
    scheduleFit(0);
    save();
  });
  ui.params.addEventListener('click', e => {
    const b = e.target.closest('[data-act="to-var"]');
    if (!b) return;
    state.roles = { ...state.roles, [b.dataset.name]: 'variable' };
    state.noVariable = false;
    refreshModel();
    scheduleFit(0);
    save();
    toast(`${b.dataset.name} now reads a data column. Check its column under Variables.`);
  });
  ui.useFitted.addEventListener('click', () => {
    const f = state.fit;
    if (!f || !f.ok) return;
    for (const p of f.parameters) {
      if (p.fixed || !Number.isFinite(p.value)) continue;
      paramState(p.name).initial = fmt(p.value, 10);
    }
    paramSignature = '';
    renderParams();
    scheduleFit(0);
    save();
    toast('The fitted values are now the starting values.');
  });

  /* Physical constants the equation seems to use. */
  function renderConstants() {
    const m = state.model;
    if (!m) { if (!ui.paramsGroup.classList.contains('is-stale')) ui.constants.hidden = true; return; }
    const items = m.suggestedConstants.filter(c => {
      const p = state.params[c.name] || {};
      return !(p.fixed && readNumber(p.initial) === c.value);
    }).map(c => `<div class="stk-callout stk-callout-accent cf-const"><i class="fa-solid fa-atom" aria-hidden="true"></i>` +
      `<span><b>${esc(c.name)}</b> may be the ${esc(c.description.charAt(0).toLowerCase() + c.description.slice(1))}, ${esc(String(c.value))} ${esc(c.units)}. Left free, it may not be separable from the parameters it multiplies.</span>` +
      `<button type="button" class="stk-btn stk-btn-sm" data-const="${esc(c.name)}">Hold ${esc(c.name)} at this value</button></div>`);
    ui.constants.innerHTML = items.join('');
    ui.constants.hidden = !items.length;
  }
  ui.constants.addEventListener('click', e => {
    const b = e.target.closest('[data-const]');
    if (!b) return;
    const c = PHYSICAL_CONSTANTS[b.dataset.const];
    if (!c) return;
    const p = paramState(b.dataset.const);
    p.initial = String(c.value);
    p.fixed = true;
    paramSignature = '';
    renderParams();
    renderConstants();
    scheduleFit(0);
    save();
    toast(`${b.dataset.const} is held at ${c.value} ${c.units}.`, 'ok');
  });

  /* ---------------- fitting ---------------- */

  let fitTimer = null;
  function scheduleFit(ms) {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => runFit(false), ms);
  }

  function rowNumbers() {
    return Array.from({ length: state.table.rows }, (_, i) => i + 1);
  }

  function columnValues(k) {
    return k === ROW_NUMBER ? rowNumbers() : state.table.columns[k].values;
  }

  function paramSpec(name) {
    const p = state.params[name] || {};
    const initial = readNumber(p.initial);
    const min = readNumber(p.min);
    const max = readNumber(p.max);
    const spec = { name };
    if (Number.isFinite(initial)) spec.initial = initial;
    const fixed = !!p.fixed && Number.isFinite(initial);
    if (!fixed && min !== null && !Number.isNaN(min)) spec.min = min;
    if (!fixed && max !== null && !Number.isNaN(max)) spec.max = max;
    if (fixed) spec.fixed = true;
    return spec;
  }

  function buildFitSpec() {
    const m = state.model;
    if (!m || !m.ready) return null;
    const columns = {};
    m.independent.forEach(v => { columns[v] = columnValues(m.map.columns[v]); });
    const hasSigma = m.map.sigma !== null && m.map.sigma !== undefined;
    return {
      ast: state.eq.ast,
      independent: [...m.independent],
      parameters: m.parameters.map(paramSpec),
      columns,
      y: columnValues(m.map.columns[m.dependent]),
      sigma: hasSigma ? state.table.columns[m.map.sigma].values : undefined,
      absoluteSigma: hasSigma && state.absoluteSigma
    };
  }

  function fitKeyOf(spec) {
    return JSON.stringify([
      toText(spec.ast), spec.independent, spec.parameters, state.model.map.columns, state.model.map.sigma,
      spec.absoluteSigma, state.dataVersion
    ]);
  }

  function runFit(force) {
    clearTimeout(fitTimer);
    const spec = buildFitSpec();
    const big = state.table.rows > AUTO_FIT_ROWS;
    ui.fitNow.hidden = !(big && spec);
    if (!spec) {
      ui.bigNote.hidden = true;
      state.fit = null;
      state.fitSpec = null;
      state.fitKey = '';
      afterFit();
      return;
    }
    const key = fitKeyOf(spec);
    if (!force && key === state.fitKey) return;
    if (big && !force) {
      // Nothing on the page may describe other data or another equation.
      state.fit = null;
      state.fitSpec = null;
      state.fitKey = '';
      afterFit();
      ui.bigNote.innerHTML = `<i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>With ${state.table.rows.toLocaleString('en-GB')} rows the fit waits for you: press <b>Fit</b> when the equation and settings are ready.</span>`;
      ui.bigNote.hidden = false;
      setStatus('Ready to fit', 'accent');
      return;
    }
    ui.bigNote.hidden = true;
    const go = () => {
      const t0 = performance.now();
      const result = fitModel(spec);
      result.elapsed = performance.now() - t0;
      state.fit = result;
      state.fitSpec = spec;
      state.fitKey = key;
      afterFit();
    };
    if (state.table.rows > 3000) {
      setStatus('Fitting\u2026', '');
      setTimeout(go, 30);
    } else {
      go();
    }
  }
  ui.fitNow.addEventListener('click', () => runFit(true));

  function afterFit() {
    renderResults();
    renderFoundValues();
    updatePlot();
    schedulePython();
    const f = state.fit;
    if (f && f.ok) {
      announce(`${f.converged ? 'Fit converged' : 'Fit did not converge'}. R squared ${fmt(f.r2, 5)}, ${plural(f.free.length, 'free parameter')}, ${plural(f.n, 'point')}.`);
    } else if (f && !f.ok) {
      announce(`No fit: ${f.message}`);
    }
  }

  /* ---------------- step 3: results ---------------- */

  function setStatus(text, kind) {
    ui.status.textContent = text;
    ui.status.className = `stk-badge${kind ? ` stk-badge-${kind}` : ''}`;
  }

  function emptyReason() {
    const m = state.model;
    if (state.table.rows < 2) return state.eq && state.eq.ok ? 'Add data on the Data tab and the fit runs straight away.' : 'Add data and an equation. The fit runs as you type.';
    if (!state.eq) return 'Type an equation in the bar above, or pick one from Models.';
    if (!state.eq.ok) return 'Correct the equation in the bar above to see the fit.';
    if (!m) return '';
    if (m.needVariable) return 'Say which name in the equation is the measured variable, on the Model tab.';
    if (m.problems.includes('parameters')) return 'The equation has nothing to fit: every name in it is a variable or a constant.';
    if (m.problems.some(p => p.startsWith('column:'))) {
      const missing = m.problems.filter(p => p.startsWith('column:')).map(p => p.slice(7));
      return `There is no data column left for ${missing.join(' and ')}. Add a column or choose one on the Model tab.`;
    }
    return '';
  }

  function renderResults() {
    const f = state.fit;
    const ok = f && f.ok;
    ui.resultBody.hidden = !ok;
    ui.failure.hidden = !(f && !f.ok);
    if (!f) {
      ui.resultsEmpty.textContent = emptyReason();
      ui.resultsEmpty.hidden = !ui.resultsEmpty.textContent;
      if (!(state.table.rows > AUTO_FIT_ROWS && buildFitSpec())) setStatus('', '');
      ui.barFit.hidden = true;
      return;
    }
    ui.resultsEmpty.hidden = true;
    if (!f.ok) {
      const extra = (f.warnings || []).filter(w => w !== f.message);
      ui.failure.innerHTML = `<i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><div class="cf-warn-list"><p>${esc(f.message)}</p>${extra.map(w => `<p>${esc(w)}</p>`).join('')}</div>`;
      setStatus('No fit', 'danger');
      ui.barFit.hidden = true;
      return;
    }
    setStatus(f.converged ? `Converged in ${plural(f.iterations, 'step')}` : 'Did not converge', f.converged ? 'ok' : 'warn');
    ui.barFit.innerHTML = `R<sup>2</sup>${f.weighted ? '<sub>w</sub>' : ''} ${fmt(f.r2, 6)}`;
    ui.barFit.hidden = false;

    const eq = state.eq;
    const m = state.model;
    const values = Object.fromEntries(f.parameters.map(p => [p.name, p.value]));
    const sub = substitute(eq.ast, values);
    const lhs = { dependent: m.dependent, arguments: eq.arguments, ast: sub };
    ui.fittedTex.innerHTML = katexHtml(toLatex(lhs), true);

    ui.paramRows.innerHTML = f.parameters.map(p => {
      const flags = [];
      if (p.fixed) flags.push('<span class="stk-badge cf-flag">fixed</span>');
      if (p.atBound) flags.push(`<span class="stk-badge stk-badge-warn cf-flag">at ${p.bound} bound</span>`);
      const rel = !p.fixed && Number.isFinite(p.stderr) && p.value !== 0 ? Math.abs(p.stderr / p.value) * 100 : NaN;
      const relText = p.fixed ? 'held fixed' : Number.isFinite(rel) ? `${fmt(rel, 2)}% relative` : '';
      const ci = p.fixed ? '<span class="cf-sub">\u2014</span>' : `<span class="cf-nw">${fmtHtml(p.ci[0], 5)}</span> to <span class="cf-nw">${fmtHtml(p.ci[1], 5)}</span>`;
      return `<tr><td><span class="cf-psym">${nameHtml(p.name)}</span>${flags.length ? `<br>${flags.join(' ')}` : ''}</td>` +
        `<td class="cf-num">${p.fixed ? fmtHtml(p.value) : valueWithErrorHtml(p.value, p.stderr)}<span class="cf-sub">${relText}</span></td>` +
        `<td class="cf-num cf-ci">${ci}</td></tr>`;
    }).join('');

    const stats = [
      [f.weighted ? 'R\u00b2 (weighted)' : 'R\u00b2', fmt(f.r2, 6)],
      ['Adjusted R\u00b2', fmt(f.adjR2, 6)],
      ['RMSE', fmtHtml(f.rmse, 4)],
      ...(f.weighted ? [['Reduced \u03c7\u00b2', fmtHtml(f.reducedChi2, 4)]] : []),
      ['AIC', fmt(f.aic, 5)],
      ['BIC', fmt(f.bic, 5)],
      ['Points', f.n.toLocaleString('en-GB')],
      ['Degrees of freedom', f.dof.toLocaleString('en-GB')]
    ];
    ui.stats.innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    const warnings = [...new Set(f.warnings || [])];
    ui.warnings.innerHTML = warnings.length
      ? `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><ul class="cf-warn-list">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`
      : '';
    ui.warnings.hidden = !warnings.length;

    const free = f.free;
    if (free.length >= 2) {
      let strong = 0;
      const head = `<thead><tr><th scope="col"><span class="sr-only">Parameter</span></th>${free.map(n => `<th scope="col">${nameHtml(n)}</th>`).join('')}</tr></thead>`;
      const body = free.map((a, i) => `<tr><th scope="row">${nameHtml(a)}</th>${free.map((b, j) => {
        const r = f.correlation[i][j];
        if (i === j) return '<td class="cf-num is-diag">1</td>';
        const hot = Math.abs(r) > 0.95;
        if (hot && j > i) strong++;
        return `<td class="cf-num${hot ? ' is-strong' : ''}">${Number.isFinite(r) ? r.toFixed(3).replace('-', '\u2212') : 'n/a'}</td>`;
      }).join('')}</tr>`).join('');
      ui.corrTable.innerHTML = head + `<tbody>${body}</tbody>`;
      ui.corrBadge.textContent = strong ? `${strong} strong` : '';
      ui.corr.hidden = false;
    } else {
      ui.corr.hidden = true;
    }
    if (ui.theory.open) renderTheory();
  }

  function renderTheory() {
    const f = state.fit;
    const eq = state.eq;
    if (!f || !f.ok || !eq || !eq.ok) { ui.theoryBody.innerHTML = ''; return; }
    const m = state.model;
    const x = m.independent.map(symbolToLatex).join(', ');
    const y = symbolToLatex(m.dependent);
    const p = f.free.length;
    const tex = t => `<div data-tex="${esc(t)}">${katexHtml(t, true)}</div>`;
    const parts = [];
    parts.push('<p>The model, with <i>p</i> = ' + p + ' free parameter' + (p === 1 ? '' : 's') + ':</p>');
    parts.push(tex(`${y} = f(${x}) = ${toLatex(eq.ast)}`));
    if (f.weighted) {
      parts.push(`<p>The parameters minimise the weighted sum of squares, each residual divided by its uncertainty:</p>`);
      parts.push(tex(`\\chi^2 = \\sum_{i=1}^{${f.n}} \\left(\\frac{${y}_i - f(${x}_i)}{\\sigma_i}\\right)^2 = ${fmtTex(f.chi2, 5)}`));
      parts.push(f.absoluteSigma
        ? '<p>The uncertainties are absolute, so the covariance is used as it is: the standard errors follow from them directly.</p>'
        : `<p>The uncertainties are relative weights, so the covariance is scaled by the reduced \u03c7\u00b2 = ${fmtHtml(f.reducedChi2, 4)}, as <span class="cf-mono">curve_fit</span> does with <span class="cf-mono">absolute_sigma=False</span>.</p>`);
    } else {
      parts.push('<p>The parameters minimise the sum of squared residuals:</p>');
      parts.push(tex(`S = \\sum_{i=1}^{${f.n}} \\left(${y}_i - f(${x}_i)\\right)^2 = ${fmtTex(f.rss, 5)}`));
      parts.push(`<p>The covariance is scaled by the residual variance <i>S</i>/(<i>n</i> \u2212 <i>p</i>) = ${fmtHtml(f.rss / f.dof, 4)}.</p>`);
    }
    parts.push(`<p>Each 95% interval is the value \u00b1 <i>t</i> \u00d7 standard error, with Student\u2019s <i>t</i> on ${f.dof} degrees of freedom.</p>`);
    parts.push(tex(`R^2 = 1 - \\frac{${f.weighted ? '\\chi^2' : 'S'}}{\\sum_i ${f.weighted ? 'w_i' : ''}(${y}_i - \\bar{${y}}${f.weighted ? '_w' : ''})^2},\\quad \\mathrm{RMSE} = \\sqrt{\\frac{1}{n}\\sum_i (${y}_i - \\hat{${y}}_i)^2}`));
    parts.push(tex(`\\mathrm{AIC} = n\\ln\\frac{${f.weighted ? '\\chi^2' : 'S'}}{n} + 2p,\\quad \\mathrm{BIC} = n\\ln\\frac{${f.weighted ? '\\chi^2' : 'S'}}{n} + p\\ln n`));
    ui.theoryBody.innerHTML = parts.join('');
  }
  ui.theory.addEventListener('toggle', () => { if (ui.theory.open) renderTheory(); });

  /* Copying results */
  function fittedText() {
    const f = state.fit;
    const eq = state.eq;
    const m = state.model;
    const values = Object.fromEntries(f.parameters.map(p => [p.name, p.value]));
    const args = eq.arguments && eq.arguments.length ? `(${eq.arguments.join(', ')})` : '';
    return `${m.dependent}${args} = ${toText(substitute(eq.ast, values))}`;
  }
  function fittedLatex() {
    const f = state.fit;
    const values = Object.fromEntries(f.parameters.map(p => [p.name, p.value]));
    return toLatex({ dependent: state.model.dependent, arguments: state.eq.arguments, ast: substitute(state.eq.ast, values) });
  }

  function statRows(f) {
    return [
      [f.weighted ? 'R\u00b2 (weighted)' : 'R\u00b2', f.r2, 'r_squared'],
      ['Adjusted R\u00b2', f.adjR2, 'adjusted_r_squared'],
      ['RMSE', f.rmse, 'rmse'],
      ...(f.weighted ? [['Reduced \u03c7\u00b2', f.reducedChi2, 'reduced_chi_squared']] : []),
      ['AIC', f.aic, 'aic'],
      ['BIC', f.bic, 'bic'],
      ['Points', f.n, 'n_points'],
      ['Degrees of freedom', f.dof, 'degrees_of_freedom']
    ];
  }

  function resultsText() {
    const f = state.fit;
    const lines = [`Fit of ${state.eqText.trim()} to ${plural(f.n, 'point')}: ${f.message}`, ''];
    const w = Math.max(9, ...f.parameters.map(p => p.name.length));
    lines.push(`${'Parameter'.padEnd(w)}  ${'Value'.padStart(13)}   ${'Std. error'.padEnd(11)}  95% interval`);
    for (const p of f.parameters) {
      const v = fmt(p.value).padStart(13);
      if (p.fixed) { lines.push(`${p.name.padEnd(w)}  ${v}   (fixed)`); continue; }
      lines.push(`${p.name.padEnd(w)}  ${v} \u00b1 ${fmt(p.stderr, 4).padEnd(11)}  [${fmt(p.ci[0], 6)}, ${fmt(p.ci[1], 6)}]`);
    }
    lines.push('');
    for (const [k, v] of statRows(f)) lines.push(`${k.padEnd(20)} ${typeof v === 'number' && Number.isInteger(v) ? v : fmt(v, 6)}`);
    lines.push('', `Fitted: ${fittedText()}`);
    const warnings = [...new Set(f.warnings || [])];
    if (warnings.length) lines.push('', ...warnings.map(x => `Note: ${x}`));
    return lines.join('\n') + '\n';
  }

  function resultsCsv() {
    const f = state.fit;
    const q = s => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const num = v => (Number.isFinite(v) ? String(v) : '');
    const lines = ['parameter,value,std_error,ci95_low,ci95_high,relative_uncertainty,fixed,at_bound'];
    for (const p of f.parameters) {
      const rel = !p.fixed && p.value !== 0 ? Math.abs(p.stderr / p.value) : NaN;
      lines.push([q(p.name), num(p.value), num(p.stderr), num(p.ci[0]), num(p.ci[1]), num(rel), p.fixed, p.atBound].join(','));
    }
    lines.push('', 'statistic,value');
    for (const [, v, key] of statRows(f)) lines.push(`${key},${num(v)}`);
    return lines.join('\n') + '\n';
  }

  function resultsLatex() {
    const f = state.fit;
    const rows = f.parameters.map(p => {
      const name = `$${symbolToLatex(p.name)}$`;
      if (p.fixed) return `${name} & $${fmtTex(p.value)}$ & (fixed) & \\\\`;
      return `${name} & $${fmtTex(p.value)}$ & $${fmtTex(p.stderr, 3)}$ & $[${fmtTex(p.ci[0], 5)},\\ ${fmtTex(p.ci[1], 5)}]$ \\\\`;
    });
    const eqTex = toLatex({ dependent: state.model.dependent, arguments: state.eq.arguments, ast: state.eq.ast });
    return [
      '\\begin{table}',
      '  \\centering',
      `  \\caption{Fit of $${eqTex}$ to $n = ${f.n}$ points; $R^2 = ${fmtTex(f.r2, 5)}$${f.weighted ? `, $\\chi^2_\\nu = ${fmtTex(f.reducedChi2, 4)}$` : ''}. Intervals are 95\\% (Student's $t$, ${f.dof} degrees of freedom).}`,
      '  \\begin{tabular}{lrrc}',
      '    \\hline',
      '    Parameter & Value & Std.\\ error & 95\\% interval \\\\',
      '    \\hline',
      ...rows.map(r => `    ${r}`),
      '    \\hline',
      '  \\end{tabular}',
      '\\end{table}'
    ].join('\n') + '\n';
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy]');
    if (!b || !state.fit || !state.fit.ok) return;
    const kind = b.dataset.copy;
    const text = kind === 'equation' ? fittedText() : kind === 'equation-tex' ? fittedLatex()
      : kind === 'text' ? resultsText() : kind === 'csv' ? resultsCsv() : resultsLatex();
    copyText(text, () => {
      flashCopied(b);
      toast(kind === 'equation' || kind === 'equation-tex' ? 'Copied the fitted equation.' : `Copied the results as ${kind === 'text' ? 'text' : kind === 'csv' ? 'CSV' : 'a LaTeX table'}.`, 'ok');
    });
  });

  /* ---------------- step 4: plot (data for it) ---------------- */

  /* What the preview draws: the data, and the curve, band and residuals once there is a fit. */
  function plotModel() {
    const m = state.model;
    const f = state.fit && state.fit.ok ? state.fit : null;
    const t = state.table;
    if (t.rows < 2 || !t.columns.length) return null;
    const cols = t.columns;
    const hasSigma = m && m.map && m.map.sigma !== null && m.map.sigma !== undefined;
    if (f && state.fitSpec) {
      const spec = state.fitSpec;
      const rows = Array.from(f.rows);
      const yAll = spec.y;
      const y = rows.map(i => yAll[i]);
      const sigma = spec.sigma ? rows.map(i => spec.sigma[i]) : undefined;
      if (spec.independent.length > 1) {
        const predicted = Array.from(f.predicted);
        return {
          x: predicted, y, sigma,
          multivariate: { observed: y, predicted },
          residuals: state.style.residuals.show ? { x: predicted, r: Array.from(f.residuals) } : undefined
        };
      }
      const xAll = spec.columns[spec.independent[0]];
      const x = rows.map(i => xAll[i]);
      const out = { x, y, sigma };
      const grid = curveGrid(x);
      if (grid && grid.length) {
        out.curve = { x: grid, y: grid.map(v => f.predict(v)) };
        if (state.style.band.show) {
          const b = f.band(grid, state.style.band.level);
          out.band = { x: grid, lower: Array.from(b.lower), upper: Array.from(b.upper) };
        }
      }
      if (state.style.residuals.show) out.residuals = { x, r: Array.from(f.residuals) };
      return out;
    }
    // No fit yet: the data alone, in the columns chosen so far.
    let xk = 0;
    let yk = cols.length > 1 ? 1 : 0;
    if (m && m.map && m.independent.length === 1) {
      xk = m.map.columns[m.independent[0]] ?? xk;
      yk = m.map.columns[m.dependent] ?? yk;
    } else if (m && m.multivariate) {
      return null;
    }
    const xv = xk === ROW_NUMBER ? rowNumbers() : cols[xk].values;
    const yv = cols[yk].values;
    const sv = hasSigma ? cols[m.map.sigma].values : null;
    const x = [];
    const y = [];
    const sigma = [];
    for (let i = 0; i < t.rows; i++) {
      if (!Number.isFinite(xv[i]) || !Number.isFinite(yv[i])) continue;
      if (sv && !(sv[i] > 0)) continue;
      x.push(xv[i]);
      y.push(yv[i]);
      if (sv) sigma.push(sv[i]);
    }
    if (x.length < 1) return null;
    return { x, y, sigma: sv ? sigma : undefined };
  }

  /*
   * Axis labels follow the data until the person writes their own: a column
   * header with its units ("t (s)") when there is one, else the variable's
   * name set as mathematics ("$t$"), which is also what the style panel
   * writes. A label counts as automatic while it is empty, the last one
   * written here, or a bare name in dollar signs.
   */
  const mathName = n => `$${symbolToLatex(String(n)) || n}$`;

  function autoLabels() {
    const m = state.model;
    const cols = state.table.columns;
    // A header that is only the name itself reads better as mathematics.
    const header = k => (k !== undefined && k !== null && cols[k] && cols[k].label && cols[k].label !== cols[k].name ? cols[k].label : null);
    const labelOf = (k, name) => (k === ROW_NUMBER ? 'Row number' : header(k) || mathName(name));
    if (m && m.map && m.multivariate) {
      const y = header(m.map.columns[m.dependent]) || mathName(m.dependent);
      return { x: `Predicted ${y}`, y: `Observed ${y}` };
    }
    if (m && m.map && m.independent.length === 1) {
      const v = m.independent[0];
      const xname = m.virtual ? (cols[m.map.columns[v]]?.name || 'x') : v;
      return { x: labelOf(m.map.columns[v], xname), y: labelOf(m.map.columns[m.dependent], m.dependent) };
    }
    if (cols.length >= 2) return { x: labelOf(0, 'x'), y: labelOf(1, 'y') };
    return { x: mathName('x'), y: mathName('y') };
  }

  const AUTO_LABEL = /^(?:(?:Predicted|Observed) )?\$[^$]*\$$/;

  function syncLabels() {
    const next = autoLabels();
    const prev = state.autoLabels || {};
    const automatic = (cur, k) => cur === '' || cur === prev[k] || cur === 'x' || cur === 'y' || AUTO_LABEL.test(cur);
    const s = { ...state.style };
    let changed = false;
    for (const k of ['x', 'y']) {
      const path = `${k}Label`;
      if (automatic(s[path], k) && s[path] !== next[k]) { s[path] = next[k]; changed = true; }
    }
    state.autoLabels = next;
    if (changed) {
      state.style = normalisePlotStyle(s);
      setPanelStyle(state.style);
    }
    return changed;
  }

  function updatePlot() {
    syncLabels();
    const model = plotModel();
    const has = !!model;
    if (!(has && state.fit && state.fit.ok)) ui.plotDrawn.hidden = true;
    if (!plotLoaded()) {
      // Until the plot area has loaded, the stage says what will appear.
      ui.plotEmpty.hidden = has;
      ui.figure.hidden = !has;
      if (!has) {
        ui.plotNotes.hidden = true;
        ui.size.textContent = '';
      }
    }
    requestDraw();
  }

  function updateStyleContext() {
    const m = state.model;
    setPanelContext({
      multivariate: !!(m && m.multivariate),
      hasSigma: !!(m && m.map && m.map.sigma !== null && m.map.sigma !== undefined),
      independent: m ? m.independent : ['x'],
      dependent: m ? m.dependent : 'y'
    });
    syncQuickToggles();
  }

  function onStyleChange(style) {
    state.style = normalisePlotStyle(style);
    syncQuickToggles();
    updatePlot();
    schedulePython();
    save();
  }

  /* The two switches beside the plot are shortcuts into the style. */
  function syncQuickToggles() {
    ui.quickResid.checked = state.style.residuals.show;
    ui.quickBand.checked = state.style.band.show;
    ui.quickBandWrap.hidden = !!(state.model && state.model.multivariate);
  }
  const quickToggle = (key, input) => input.addEventListener('change', () => {
    const style = normalisePlotStyle({ ...state.style, [key]: { ...state.style[key], show: input.checked } });
    setPanelStyle(style);
    onStyleChange(style);
  });
  quickToggle('residuals', ui.quickResid);
  quickToggle('band', ui.quickBand);
  // Once the plot area has loaded, its Style button (openStyle) does this.
  ui.editStyle.addEventListener('click', () => { if (!plotArea) selectTab('style', { focus: true, reveal: true }); });


  /* ---------------- step 5: Python ---------------- */

  const schedulePython = debounce(() => renderPython(), 150);

  function pySource() {
    return state.pySource || (state.table.rows > EMBED_ROWS ? 'csv' : 'embed');
  }

  function csvHeaders() {
    const m = state.model;
    const names = state.table.columns.map(c => c.name);
    const usesRow = m && m.map && Object.values(m.map.columns).includes(ROW_NUMBER);
    const rowName = usesRow ? columnIdentifier('row', names.length, new Set(names)) : null;
    return { names, rowName };
  }

  function csvText() {
    const t = state.table;
    const { names, rowName } = csvHeaders();
    const q = s => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [[...(rowName ? [rowName] : []), ...names].map(q).join(',')];
    for (let i = 0; i < t.rows; i++) {
      const cells = t.columns.map(c => (Number.isFinite(c.values[i]) ? String(c.values[i]) : ''));
      if (rowName) cells.unshift(String(i + 1));
      lines.push(cells.join(','));
    }
    return lines.join('\n') + '\n';
  }

  function pythonSpec() {
    const m = state.model;
    const spec = buildFitSpec();
    if (!m || !m.ready || !spec) return null;
    const cols = state.table.columns;
    const labelOf = k => (k === ROW_NUMBER ? 'row number' : cols[k].label || cols[k].name);
    const names = {};
    m.independent.forEach(v => { names[v] = labelOf(m.map.columns[v]); });
    names[m.dependent] = labelOf(m.map.columns[m.dependent]);
    let dataSource = { kind: 'embed' };
    if (pySource() === 'csv') {
      const { names: ids, rowName } = csvHeaders();
      const header = k => (k === ROW_NUMBER ? rowName : ids[k]);
      const columns = {};
      m.independent.forEach(v => { columns[v] = header(m.map.columns[v]); });
      columns[m.dependent] = header(m.map.columns[m.dependent]);
      if (spec.sigma) columns.sigma = ids[m.map.sigma];
      dataSource = { kind: 'csv', file: state.csvName || 'data.csv', columns, delimiter: ',' };
    }
    const fit = state.fit && state.fit.ok && state.fitSpec && fitKeyOf(spec) === state.fitKey ? state.fit : undefined;
    return {
      equation: state.eqText.trim(),
      ast: state.eq.ast,
      dependent: m.dependent,
      independent: m.independent,
      parameters: spec.parameters.map(p => ({ name: p.name, initial: p.initial, min: p.min ?? null, max: p.max ?? null, fixed: !!p.fixed })),
      data: { columns: spec.columns, y: spec.y, sigma: spec.sigma, names },
      dataSource,
      absoluteSigma: spec.absoluteSigma,
      style: state.style,
      fit
    };
  }

  function renderPython() {
    const src = pySource();
    ui.srcEmbed.setAttribute('aria-pressed', String(src === 'embed'));
    ui.srcCsv.setAttribute('aria-pressed', String(src === 'csv'));
    ui.srcEmbed.classList.toggle('is-active', src === 'embed');
    ui.srcCsv.classList.toggle('is-active', src === 'csv');
    ui.csvOpts.hidden = src !== 'csv';
    ui.csvDownload.disabled = state.table.rows < 1;
    const fileName = `${state.style.export.filename || 'fit'}.py`;
    ui.pyName.textContent = fileName;
    const spec = pythonSpec();
    if (!spec) {
      state.pyText = '';
      ui.pyCode.innerHTML = `<span class="cf-code-empty"># The script appears here once there are data and an equation to fit.</span>`;
      ui.pyCopy.disabled = true;
      ui.pyDownload.disabled = true;
      ui.pyFoot.innerHTML = `Runs with Python 3, numpy, scipy and matplotlib 3.6 or later (3.11 or later to match the preview): <code>python ${esc(fileName)}</code>. It prints the parameters and saves the figure.`;
      return;
    }
    let text;
    try {
      text = generateFitScript(spec);
    } catch (err) {
      state.pyText = '';
      ui.pyCode.textContent = `# The script could not be written: ${err && err.message ? err.message : err}`;
      ui.pyCopy.disabled = true;
      ui.pyDownload.disabled = true;
      return;
    }
    state.pyText = text;
    ui.pyCode.innerHTML = text.length < 400000 ? highlightPython(text) : esc(text);
    ui.pyCopy.disabled = false;
    ui.pyDownload.disabled = false;
    const ext = state.style.export.format;
    ui.pyFoot.innerHTML = `Runs with Python 3, numpy, scipy and matplotlib 3.6 or later (3.11 or later to match the preview): <code>python ${esc(fileName)}</code>. It prints the parameters and saves <code>${esc(state.style.export.filename)}.${esc(ext)}</code>` +
      (src === 'csv' ? `, reading the data from <code>${esc(state.csvName || 'data.csv')}</code> in the same folder.` : '.');
  }

  [ui.srcEmbed, ui.srcCsv].forEach(b => b.addEventListener('click', () => {
    state.pySource = b.dataset.src;
    renderPython();
    save();
  }));
  ui.csvName.addEventListener('input', () => {
    let v = ui.csvName.value.trim().replace(/[\\/:*?"<>|]+/g, '_');
    state.csvName = v || 'data.csv';
    schedulePython();
    save();
  });
  ui.csvDownload.addEventListener('click', () => {
    if (!state.table.rows) return;
    download(csvText(), state.csvName || 'data.csv', 'text/csv');
    toast(`Saved ${state.csvName || 'data.csv'}. Keep it in the same folder as the script.`, 'ok');
  });
  ui.pyCopy.addEventListener('click', () => {
    if (!state.pyText) return;
    copyText(state.pyText, () => {
      flashCopied(ui.pyCopy);
      ui.pyTaken.hidden = false;
      toast('Copied the Python script.', 'ok');
    });
  });
  ui.pyDownload.addEventListener('click', () => {
    if (!state.pyText) return;
    const name = `${state.style.export.filename || 'fit'}.py`;
    download(state.pyText, name, 'text/x-python');
    ui.pyTaken.hidden = false;
    toast(`Saved ${name}.`, 'ok');
  });

  /* ---------------- saving what the person did ---------------- */

  function snapshot() {
    const names = state.model ? new Set([...state.model.names, state.model.dependent]) : new Set();
    const params = {};
    for (const [k, v] of Object.entries(state.params)) {
      if (names.has(k) || Object.keys(params).length < 40) params[k] = v;
    }
    return {
      v: STORE_VERSION,
      eq: state.eqText,
      roles: state.roles,
      asParameters: state.asParameters,
      noVariable: state.noVariable,
      chosen: state.chosen,
      params,
      absoluteSigma: state.absoluteSigma,
      style: state.style,
      autoLabels: state.autoLabels,
      pySource: state.pySource,
      csvName: state.csvName,
      dataName: state.dataName,
      sample: state.sample,
      data: state.dataText.length <= MAX_STORED_DATA ? state.dataText : null
    };
  }

  const save = debounce(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(snapshot())); } catch (e) { /* storage full or blocked */ }
  }, 400);

  function restore(saved) {
    if (!saved || typeof saved !== 'object' || saved.v !== STORE_VERSION) return false;
    const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    state.roles = obj(saved.roles);
    state.asParameters = Array.isArray(saved.asParameters) ? saved.asParameters.filter(n => typeof n === 'string') : [];
    state.noVariable = !!saved.noVariable;
    state.chosen = obj(saved.chosen);
    state.params = obj(saved.params);
    state.absoluteSigma = !!saved.absoluteSigma;
    ui.abs.checked = state.absoluteSigma;
    state.style = normalisePlotStyle(obj(saved.style));
    state.autoLabels = saved.autoLabels && typeof saved.autoLabels.x === 'string' ? saved.autoLabels : null;
    state.pySource = saved.pySource === 'csv' || saved.pySource === 'embed' ? saved.pySource : null;
    state.csvName = typeof saved.csvName === 'string' && saved.csvName ? saved.csvName : 'data.csv';
    ui.csvName.value = state.csvName;
    ui.eq.value = typeof saved.eq === 'string' ? saved.eq : '';
    state.eqText = ui.eq.value;
    if (typeof saved.data === 'string') {
      ui.dataText.value = saved.data;
      state.dataText = saved.data;
      state.dataName = typeof saved.dataName === 'string' ? saved.dataName : '';
    }
    state.table = parseTable(state.dataText);
    state.sample = typeof saved.sample === 'string' ? saved.sample : null;
    return true;
  }

  function resetAll() {
    const before = snapshot();
    const hadData = state.dataText;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* blocked */ }
    Object.assign(state, {
      dataText: '', dataName: '', table: parseTable(''), sample: null, eqText: '', eq: null, roles: {}, asParameters: [],
      noVariable: false, chosen: {}, params: {}, absoluteSigma: false, style: defaultPlotStyle(), autoLabels: null,
      pySource: null, csvName: 'data.csv', model: null, fit: null, fitSpec: null, fitKey: ''
    });
    state.dataVersion++;
    ui.dataText.value = '';
    ui.eq.value = '';
    ui.abs.checked = false;
    ui.csvName.value = 'data.csv';
    ui.pyTaken.hidden = true;
    setPanelStyle(state.style);
    paramSignature = '';
    autoGrow();
    renderData();
    refreshModel();
    runFit(true);
    selectTab('data');
    save.cancel();
    toast('Cleared the data, the equation and the plot style.', '', {
      label: 'Undo',
      run: () => {
        restore({ ...before, data: before.data ?? hadData });
        state.dataVersion++;
        setPanelStyle(state.style);
        paramSignature = '';
        autoGrow();
        renderData();
        refreshModel();
        runFit(true);
        save();
      }
    });
  }
  ui.reset.addEventListener('click', resetAll);
  ui.example.addEventListener('click', () => loadSample('decay'));
  ui.tryExample.addEventListener('click', () => loadSample('decay'));

  /* ------------------------------------------------------------------ *
   * Plot: every call into js/fit-plot.js and the shared plot area
   * (mountFigure in js/figure-plot.js) is in this section. The modules are
   * loaded on their own, so the page still fits and writes the script if the
   * plot cannot load. The plot area draws, sizes, notes and exports the
   * figure; the page keeps its own switches, Style tab and style panel.
   * ------------------------------------------------------------------ */

  let fitPlot = null;
  let plotArea = null;
  let stylePanel = null;
  let panelContext = null;
  let drawing = false;
  let drawAgain = false;

  function plotLoaded() { return !!plotArea; }

  function curveGrid(x) {
    if (fitPlot) return Array.from(fitPlot.fitCurveGrid(x, state.style));
    // Before the module arrives: evenly spaced over the data.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(hi > lo)) return [lo];
    const n = state.style.fit.samples;
    return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
  }

  function setPanelStyle(style) {
    if (stylePanel) stylePanel.set(style);
  }

  function setPanelContext(ctx) {
    panelContext = ctx;
    if (stylePanel) stylePanel.setContext(ctx);
  }

  /*
   * Beside the inputs the whole figure should fit under the site header and
   * the equation bar, so it can be read while the inputs change; stacked on a
   * narrow screen it may be as large as the width allows.
   */
  function previewMaxScale() {
    if (narrow.matches) return 2;
    const room = window.innerHeight - headHeight() - ui.bar.getBoundingClientRect().height - 120;
    const tall = state.style.height * 96;
    return Math.max(0.2, Math.min(2, room / tall));
  }


  async function requestDraw() {
    if (!plotArea) return;
    if (drawing) { drawAgain = true; return; }
    drawing = true;
    try {
      do {
        drawAgain = false;
        await drawOnce();
      } while (drawAgain);
    } finally {
      drawing = false;
    }
  }

  async function drawOnce() {
    const model = plotModel();
    const info = await plotArea.update(model ? fitPlot.fitFigure(model, state.style) : null);
    ui.plotDrawn.hidden = !(info && state.fit && state.fit.ok);
  }

  function exported(r, err, format) {
    if (err) {
      toast(`The ${format.toUpperCase()} could not be made: ${err && err.message ? err.message : err}`, 'danger');
      return;
    }
    const size = r && Number.isFinite(r.widthIn) ? ` (${fmt(r.widthIn, 3)} \u00d7 ${fmt(r.heightIn, 3)} in)` : '';
    toast(`Saved ${r && r.filename ? r.filename : `${state.style.export.filename}.${format}`}${size}.`, 'ok');
  }

  ui.styleHost.innerHTML = '<p class="cf-style-wait">Loading the style options\u2026</p>';
  Promise.all([import('./fit-plot.js'), import('./figure-plot.js')]).then(([mod, figures]) => {
    fitPlot = mod;
    plotArea = figures.mountFigure(ui.plotSection, {
      stylePanel: false, maxScale: previewMaxScale, onExport: exported,
      label: 'The data and the fitted curve, as the saved figure will look',
      // The Style button and openStyle({ series }): the Style tab, on one
      // series ('data', 'fit', 'band' or 'residuals') when named.
      onStyle: (what) => {
        const series = what && what.series;
        selectTab('style', { focus: series === undefined, reveal: true });
        if (series !== undefined && stylePanel) stylePanel.showSeries(series);
      }
    });
    ui.styleHost.innerHTML = '';
    // Labels restored from an earlier visit are kept: the panel only fills in
    // labels that are still its automatic ones.
    let starting = true;
    stylePanel = mod.createStylePanel(ui.styleHost, state.style, style => { if (!starting) onStyleChange(style); },
      panelContext ? { context: panelContext } : {});
    starting = false;
    state.style = normalisePlotStyle(stylePanel.get());
    updatePlot();
    // The preview rescales itself to the width; a new window height changes
    // how large it may be in the sticky column, which needs a new drawing.
    let lastHeight = window.innerHeight;
    window.addEventListener('resize', debounce(() => {
      if (Math.abs(window.innerHeight - lastHeight) > 40) { lastHeight = window.innerHeight; requestDraw(); }
    }, 200));
  }).catch(err => {
    ui.styleHost.innerHTML = '<p class="cf-style-wait">The plot could not load, so the style options are not available. The fit and the Python script still work.</p>';
    ui.plotNotes.innerHTML = `<p>The plot could not load (${esc(err && err.message ? err.message : String(err))}). Reload the page to try again.</p>`;
    ui.plotNotes.hidden = false;
  });

  /* ---------------- start ---------------- */

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { saved = null; }
  restore(saved);
  autoGrow();
  renderData();
  refreshModel();
  let savedTab = null;
  try { savedTab = localStorage.getItem(TAB_KEY); } catch (e) { savedTab = null; }
  selectTab(state.table.rows >= 2 && ['model', 'style'].includes(savedTab) ? savedTab : 'data');
  runFit(true);
  renderPython();
}
