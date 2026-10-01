/**
 * @module core/fit-python
 *
 * Writes the Python script behind a fit typed as an equation. The script runs
 * as is with numpy, scipy and matplotlib: it holds the data (or reads the
 * user's CSV file), defines the model as a function, fits it with
 * scipy.optimize.curve_fit exactly as the page does, prints each parameter
 * with its standard error and 95% confidence interval, and draws the figure
 * the page previews before saving it.
 *
 * The page rewrites the script on every change to the equation, the data or
 * the plot style, so generation is quick and gives the same text for the same
 * input. Every field of the plot style (see `plot-style.js`) has a matplotlib
 * meaning here, written out as an explicit call so that a reader can find the
 * line to change.
 *
 * Numbers are written as the shortest text that reads back as the same double,
 * and rows are dropped by the page's rule, so the script fits exactly the data
 * the page fitted. The page searches for starting values when a fit from the
 * typed ones goes poorly, so when its result is passed in, the script starts
 * curve_fit from that result and quotes the typed values in a comment. With no
 * bounds the script leaves them out of the call, which keeps scipy on the
 * Levenberg–Marquardt method the page uses; with bounds scipy switches to its
 * trust-region method, which ends in the same place when the fit settles
 * inside the bounds. R² is weighted when there are uncertainties, as on the
 * page; RMSE is not.
 */

import { FUNCTIONS, CONSTANTS } from './expression.js';
import { normalisePlotStyle } from './plot-style.js';
import {
  pyNum, short, pyStr, comment, wrapItems, pyArray, pyCall, wrapComment, rcLines, subplotsLines, seriesLines, scaleComment,
  tickLines, frameBody, legendCall, saveLines, gridOn
} from './figure-python.js';

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  'match', 'case', 'type', '_'
]);

const BUILTINS = new Set([
  'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes', 'callable', 'chr',
  'classmethod', 'compile', 'complex', 'copyright', 'credits', 'delattr', 'dict', 'dir', 'divmod',
  'enumerate', 'eval', 'exec', 'exit', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals',
  'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len',
  'license', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object', 'oct', 'open',
  'ord', 'pow', 'print', 'property', 'quit', 'range', 'repr', 'reversed', 'round', 'set', 'setattr',
  'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'vars', 'zip', 'Ellipsis',
  'NotImplemented', '__import__', '__name__', '__file__', '__doc__', '__builtins__'
]);

/**
 * The names the script itself uses at module level, so that a symbol in the
 * user's equation never shadows one of them.
 */
const SCRIPT_NAMES = new Set([
  'np', 'scipy', 'plt', 'matplotlib', 'ticker', 'stats', 'curve_fit', 'csv',
  'model', 'free_model', 'fixed', 'fitted', 'p0', 'bounds', 'popt', 'pcov', 'perr', 'residuals',
  'n_points', 'n_free', 'dof', 't_crit', 'ss_res', 'ss_tot', 'r_squared', 'rmse', 'chi2_red',
  'weights', 'chi2', 'weighted_mean',
  'confidence_band', 'read_columns', 'keep', 'x_fit', 'y_fit', 'half', 'predicted', 'line', 'lo', 'hi',
  'band', 'fit_line', 'data_points', 'residual_points', 'both', 'fig', 'ax', 'ax_res', 'axes', 'spine', 'formatter',
  'name', 'value', 'err', 'SHOW_BACKENDS'
]);

const RESERVED = new Set([...KEYWORDS, ...BUILTINS, ...SCRIPT_NAMES]);

/**
 * A valid, readable Python identifier for a symbol in the user's equation.
 *
 * Letters from any script are kept (Python 3 accepts `τ` or `λ` as names),
 * after the NFKC normalisation Python itself applies, so two symbols that
 * Python would read as one name are told apart here. Other characters become
 * `_`. A keyword, a builtin such as `lambda`, `len`, `sum` or `min`, or a name
 * the script uses itself (`np`, `plt`, `popt`, ...) gets a trailing `_`, and
 * so does any name already in `taken`, until it is unique.
 *
 * @param {string} name - The symbol as the user typed it.
 * @param {Set<string>} [taken] - Names already in use; the result is added.
 * @returns {string}
 */
export function pythonName(name, taken = new Set()) {
  let id = String(name ?? '').normalize('NFKC')
    .replace(/[^\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]/gu, '_');
  if (!id) id = 'p';
  if (!/^[\p{L}\p{Nl}_]/u.test(id)) id = '_' + id;
  while (RESERVED.has(id) || taken.has(id)) id += '_';
  taken.add(id);
  return id;
}

/* ------------------------------------------------------------------ *
 * Expressions
 * ------------------------------------------------------------------ */

const ADD = 1, MUL = 2, UNARY = 3, POW = 4, ATOM = 5;

function constantCode(name) {
  return Object.hasOwn(CONSTANTS, name) ? CONSTANTS[name].python : null;
}

function lookup(names, name) {
  if (names instanceof Map) return names.has(name) ? names.get(name) : undefined;
  return names && Object.hasOwn(names, name) ? names[name] : undefined;
}

/**
 * A number as the user wrote it (`1e-3`, `6.022e23`) when that is also a
 * Python literal, which reads to the same double; otherwise the shortest
 * round-trip form.
 */
function pyLiteral(node) {
  const raw = typeof node.raw === 'string' ? node.raw.trim() : '';
  const python = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) && !/^0\d+$/.test(raw);
  return python && Number(raw) === node.value ? raw : pyNum(node.value);
}

function wrap(part, needed) {
  return part.prec < needed ? `(${part.code})` : part.code;
}

function emit(node, names) {
  switch (node && node.type) {
    case 'number':
      return { code: pyLiteral(node), prec: ATOM };
    case 'symbol': {
      const mapped = lookup(names, node.name);
      if (mapped !== undefined) return { code: mapped, prec: ATOM };
      const constant = constantCode(node.name);
      if (constant) return { code: constant, prec: ATOM };
      throw new Error(`No Python name for the symbol "${node.name}".`);
    }
    case 'unary': {
      const arg = emit(node.arg, names);
      if (node.op === '+') return arg;
      // Negation passes exactly through * and /, so -a*b needs no brackets:
      // Python reads it as (-a)*b, which is the same number as -(a*b).
      if (arg.prec >= MUL && !arg.code.startsWith('-') && arg.prec !== UNARY) {
        return { code: '-' + arg.code, prec: arg.prec === MUL ? MUL : UNARY };
      }
      return { code: `-(${arg.code})`, prec: UNARY };
    }
    case 'binary': {
      const { op } = node;
      if (op === '+' || op === '-') {
        let right = node.right;
        let sign = op;
        // a + -b is a - b, and a - -b is a + b, exactly.
        if (right.type === 'unary' && right.op === '-') {
          sign = op === '+' ? '-' : '+';
          right = right.arg;
        } else if (right.type === 'unary' && right.op === '+') {
          right = right.arg;
        }
        const l = emit(node.left, names);
        const r = emit(right, names);
        return { code: `${wrap(l, ADD)} ${sign} ${wrap(r, MUL)}`, prec: ADD };
      }
      if (op === '*' || op === '/') {
        const l = emit(node.left, names);
        const r = emit(node.right, names);
        return { code: `${wrap(l, MUL)}${op}${wrap(r, UNARY)}`, prec: MUL };
      }
      if (op === '^' || op === '**') {
        const l = emit(node.left, names);
        const r = emit(node.right, names);
        return { code: `${wrap(l, ATOM)}**${wrap(r, UNARY)}`, prec: POW };
      }
      throw new Error(`Unknown operator "${op}".`);
    }
    case 'call': {
      const fn = Object.hasOwn(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : null;
      if (!fn || typeof fn.python !== 'string') throw new Error(`No Python spelling for the function "${node.name}".`);
      const args = (node.args || []).map((a) => emit(a, names).code).join(', ');
      // A spelling with '…' takes the arguments in its place: np.heaviside(…, 0.5).
      if (fn.python.includes('\u2026')) return { code: fn.python.replace('\u2026', args), prec: ATOM };
      return { code: `${fn.python}(${args})`, prec: ATOM };
    }
    default:
      throw new Error('Not an expression node.');
  }
}

/**
 * numpy code for an equation's right-hand side.
 *
 * Brackets are written only where Python needs them to evaluate the same tree:
 * `^` becomes `**`, implicit multiplication an explicit `*`, functions take
 * their numpy or scipy spelling from `FUNCTIONS`, and `pi` and `e` become
 * `np.pi` and `np.e` unless `names` maps them to something else. Operands of
 * the same precedence on the right keep their brackets, so `a - (b - c)` stays
 * as written and the arithmetic happens in the order the page's evaluator uses.
 *
 * @param {object} ast - A node from `parseEquation`.
 * @param {Object<string, string>|Map<string, string>} [names] - Python name for each symbol.
 * @returns {string}
 */
export function expressionToPython(ast, names = {}) {
  return emit(ast, names).code;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (node.type === 'unary') walk(node.arg, visit);
  else if (node.type === 'binary') { walk(node.left, visit); walk(node.right, visit); }
  else if (node.type === 'call') (node.args || []).forEach((a) => walk(a, visit));
}

/* ------------------------------------------------------------------ *
 * The script
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} FitScriptSpec
 * @property {string} equation - The user's text, quoted in a comment.
 * @property {object} ast - The right-hand side from `parseEquation`.
 * @property {string} dependent - The symbol on the left, such as 'y'.
 * @property {string[]} independent - The independent variables, in order.
 * @property {{name: string, initial?: number, min?: number|null, max?: number|null, fixed?: boolean}[]} parameters
 * @property {{columns: Object<string, number[]>, y: number[], sigma?: number[], names?: Object<string, string>}} data
 * @property {{kind: 'embed'}|{kind: 'csv', file: string, columns: Object<string, string>, delimiter?: string}} [dataSource]
 * @property {boolean} [absoluteSigma] - Whether sigma is an absolute uncertainty.
 * @property {object} style - A plot style (normalised here again).
 * @property {{parameters: {name: string, value: number, stderr?: number}[], r2?: number}} [fit] - The page's
 *   result (`fitModel`'s return value will do): quoted in comments, and the start for curve_fit.
 */

/**
 * The complete Python script for a fit: data, model, fit, printed report and
 * the figure, saved in the style's export format.
 *
 * Rows with a missing or non-finite value in any column the fit uses are left
 * out, as on the page, and the script says how many. With several independent
 * variables there is no curve to draw over one axis, so the figure plots the
 * observed values against the model's predictions, with the diagonal drawn in
 * the fit's line style, and the residuals against the predictions below.
 *
 * @param {FitScriptSpec} spec
 * @returns {string}
 */
export function generateFitScript(spec) {
  const s = normalisePlotStyle(spec.style);
  const ast = spec.ast;
  const independent = Array.isArray(spec.independent) ? spec.independent : [spec.independent];
  const multi = independent.length > 1;
  const params = (spec.parameters || []).map((p) => ({ ...p, fixed: !!p.fixed }));
  const free = params.filter((p) => !p.fixed);
  const fixedParams = params.filter((p) => p.fixed);
  const source = spec.dataSource && spec.dataSource.kind === 'csv' ? spec.dataSource : { kind: 'embed' };
  const data = spec.data || { columns: {}, y: [] };
  const hasSigma = source.kind === 'csv'
    ? !!(source.columns && source.columns.sigma)
    : Array.isArray(data.sigma) && data.sigma.length > 0;
  const absoluteSigma = !!spec.absoluteSigma;

  // Python names: the user's symbols first, so they keep their spelling.
  const taken = new Set();
  const names = new Map();
  independent.forEach((v) => names.set(v, pythonName(v, taken)));
  const dep = pythonName(spec.dependent || 'y', taken);
  params.forEach((p) => { if (!names.has(p.name)) names.set(p.name, pythonName(p.name, taken)); });
  const errName = hasSigma ? pythonName(`${dep}_err`, taken) : null;
  const pack = multi ? pythonName('X', taken) : null;
  const xs = independent.map((v) => names.get(v));
  const x0 = xs[0];
  const pn = (p) => names.get(p.name);

  const body = expressionToPython(ast, names);
  const used = new Set();
  const symbols = new Set();
  walk(ast, (n) => {
    if (n.type === 'call' && Object.hasOwn(FUNCTIONS, n.name)) used.add(FUNCTIONS[n.name].python);
    if (n.type === 'symbol') symbols.add(n.name);
  });
  const needsSpecial = [...used].some((p) => /\bscipy\.special\b/.test(p));
  const constantModel = !independent.some((v) => symbols.has(v));

  const F = fixedParams.length ? 'free_model' : 'model';
  const xdata = multi ? pack : x0;
  const L = [];
  const blank = () => L.push('');
  const section = (title) => { L.push(`# ${title} ` + '-'.repeat(Math.max(4, 76 - title.length))); };

  const fileName = `${s.export.filename}.${s.export.format}`;
  const eqText = comment(spec.equation || `${spec.dependent} = ...`);

  /* Header */
  L.push('# Curve fit from STEMKit (https://stemkit.net/curve-fitter.html)');
  L.push('#');
  L.push(`#     ${eqText}`);
  L.push('#');
  L.push('# Fits the model by non-linear least squares with scipy.optimize.curve_fit,');
  L.push('# prints each parameter with its standard error and 95% confidence interval,');
  L.push(`# draws the figure as the page shows it and saves it as ${fileName}.`);
  L.push('# Needs numpy, scipy and matplotlib 3.6 or later (3.11 or later to match the preview).');
  blank();

  /* Imports */
  if (source.kind === 'csv') L.push('import csv', '');
  L.push('import numpy as np');
  L.push('import matplotlib');
  L.push('import matplotlib.pyplot as plt');
  L.push('from matplotlib import ticker');
  L.push('from scipy import stats');
  L.push('from scipy.optimize import curve_fit');
  if (needsSpecial) L.push('import scipy.special');
  blank();

  /* Data */
  section('Data');
  const dataNames = [...xs, dep, ...(hasSigma ? [errName] : [])];
  if (source.kind === 'csv') {
    const cols = source.columns || {};
    const known = data.names && typeof data.names === 'object' ? data.names : {};
    const header = (sym) => String(cols[sym] ?? known[sym] ?? sym);
    const headers = [
      ...independent.map(header),
      header(spec.dependent),
      ...(hasSigma ? [cols.sigma] : [])
    ];
    const delimiter = typeof source.delimiter === 'string' && source.delimiter.length === 1 ? source.delimiter : ',';
    L.push('def read_columns(path, headers, delimiter=\',\'):');
    L.push('    """The named columns of a CSV file as arrays; blank or non-numeric cells become NaN."""');
    L.push("    with open(path, newline='', encoding='utf-8-sig') as fh:");
    L.push('        reader = csv.DictReader(fh, delimiter=delimiter)');
    L.push('        reader.fieldnames = [field.strip() for field in reader.fieldnames or []]');
    L.push('        rows = list(reader)');
    L.push('    missing = [h for h in headers if h not in (reader.fieldnames or [])]');
    L.push('    if missing:');
    L.push("        raise KeyError(f'{path} has no column named {missing[0]!r}')");
    blank();
    L.push('    def number(text):');
    L.push('        try:');
    L.push('            return float(text)');
    L.push('        except (TypeError, ValueError):');
    L.push('            return np.nan');
    blank();
    L.push('    return [np.array([number(row[h]) for row in rows]) for h in headers]');
    blank();
    blank();
    L.push(`# Point this at your file; the columns are matched by their headers.`);
    const args = [pyStr(source.file || 'data.csv'), `[${headers.map(pyStr).join(', ')}]`];
    if (delimiter !== ',') args.push(`delimiter=${pyStr(delimiter)}`);
    L.push(...pyCall(`${dataNames.join(', ')} = read_columns`, args));
    L.push(hasSigma
      ? '# Rows with a missing value, or an uncertainty that is not positive, are left out, as on the page.'
      : '# Rows with a missing value are left out, as on the page.');
    L.push(`keep = ${dataNames.map((n) => `np.isfinite(${n})`).join(' & ')}${hasSigma ? ` & (${errName} > 0)` : ''}`);
    L.push(`print(f'{np.count_nonzero(~keep)} rows left out')`);
    L.push(`${dataNames.join(', ')} = ${dataNames.map((n) => `${n}[keep]`).join(', ')}`);
  } else {
    const cols = independent.map((v) => (data.columns && data.columns[v]) || []);
    const ys = data.y || [];
    const sig = hasSigma ? data.sigma : null;
    const n = Math.min(ys.length, ...cols.map((c) => c.length), ...(sig ? [sig.length] : []));
    // The page's rule: a row needs numbers for every variable, and a positive
    // uncertainty when there are uncertainties.
    const rows = [];
    let blankRows = 0, badSigma = 0;
    for (let i = 0; i < n; i++) {
      const row = [...cols.map((c) => toNumber(c[i])), toNumber(ys[i])];
      if (!row.every(Number.isFinite)) { blankRows++; continue; }
      if (sig) {
        const e = toNumber(sig[i]);
        if (!(e > 0) || !Number.isFinite(e)) { badSigma++; continue; }
        row.push(e);
      }
      rows.push(row);
    }
    const labels = (data.names && typeof data.names === 'object') ? data.names : {};
    const described = [...independent, spec.dependent].map((v, i) => {
      const nm = labels[v];
      return nm && nm !== v ? `${dataNames[i]}: ${comment(nm)}` : null;
    }).filter(Boolean);
    const plural = (k, what) => `${k} row${k === 1 ? '' : 's'} ${what}`;
    const left = [
      blankRows ? plural(blankRows, 'with a blank or non-numeric value') : '',
      badSigma ? plural(badSigma, 'whose uncertainty was missing, zero or negative') : ''
    ].filter(Boolean);
    L.push(`# ${rows.length} points${left.length ? `; ${left.join(' and ')} left out, as on the page` : ''}.`);
    if (hasSigma) L.push(`# ${errName} is the standard uncertainty of each ${dep} value.`);
    if (described.length) L.push(`# Columns: ${described.join('; ')}.`);
    // Pushed line by line: a spread of a long array would run out of stack.
    dataNames.forEach((name, j) => { for (const line of pyArray(name, rows.map((r) => r[j]))) L.push(line); });
  }
  if (multi) {
    L.push(`# curve_fit takes the independent variables as one array, one row each.`);
    L.push(`${pack} = np.vstack([${xs.join(', ')}])`);
  }
  blank();
  blank();

  /* Model */
  section('Model');
  L.push(`# ${eqText}`);
  const argList = [xdata, ...params.map(pn)].join(', ');
  L.push(`def model(${argList}):`);
  if (multi) L.push(`    ${xs.join(', ')} = ${pack}`);
  if (constantModel) {
    L.push(`    # The model does not depend on ${xs.join(' or ')}, so give one value per point.`);
    L.push(`    return np.full(np.shape(${x0}), ${body}, dtype=float)`);
  } else {
    L.push(`    return ${body}`);
  }
  blank();
  blank();
  if (fixedParams.length) {
    L.push('# Held fixed at the values you set; curve_fit adjusts only the other parameters.');
    L.push(`fixed = {${fixedParams.map((p) => `${pyStr(pn(p))}: ${pyNum(clampTo(p, finiteOr(p.initial, 1)))}`).join(', ')}}`);
    blank();
    blank();
    L.push(`def free_model(${[xdata, ...free.map(pn)].join(', ')}):`);
    const call = params.map((p) => (p.fixed ? `fixed[${pyStr(pn(p))}]` : pn(p)));
    L.push(...pyCall('return model', [xdata, ...call], '    '));
    blank();
    blank();
  }

  /* Fit */
  section('Fit');
  // The page searches for starting values when a fit from the typed ones goes
  // poorly, so the surest way to land on its minimum is to start from its result.
  const found = new Map(((spec.fit && Array.isArray(spec.fit.parameters)) ? spec.fit.parameters : [])
    .filter((p) => isNum(p.value)).map((p) => [p.name, Number(p.value)]));
  const fromPage = free.length > 0 && free.every((p) => found.has(p.name));
  // scipy refuses a start outside the bounds, so start at the nearest bound, as the page does.
  const p0 = free.map((p) => clampTo(p, fromPage ? found.get(p.name) : finiteOr(p.initial, 1)));
  const bounded = free.some((p) => isNum(p.min) || isNum(p.max));
  if (fromPage) {
    L.push('# Starting values: the page\'s result, so that curve_fit settles on the same minimum.');
    const typed = free.filter((p) => isNum(p.initial)).map((p) => `${pn(p)} = ${short(p.initial)}`);
    const searched = free.filter((p) => !isNum(p.initial)).map(pn);
    const list = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0]);
    L.push(...wrapComment([
      typed.length ? `The starting values typed on the page were ${typed.join(', ')}.` : '',
      searched.length ? `The page searched for a start for ${list(searched)}.` : ''
    ].filter(Boolean).join(' ')));
  } else {
    L.push(`# Starting values${bounded ? ' and bounds' : ''}, in the order of the free parameters: ${free.map(pn).join(', ')}.`);
  }
  L.push(`p0 = [${p0.map(pyNum).join(', ')}]${fromPage ? `  # ${free.map(pn).join(', ')}` : ''}`);
  if (bounded) {
    const lo = free.map((p) => (isNum(p.min) ? pyNum(p.min) : '-np.inf'));
    const hi = free.map((p) => (isNum(p.max) ? pyNum(p.max) : 'np.inf'));
    L.push(`bounds = ([${lo.join(', ')}], [${hi.join(', ')}])`);
    L.push('# With bounds curve_fit uses its trust-region method; it ends where the page does');
    L.push('# whenever the fit settles inside the bounds.');
  } else {
    L.push('# No bounds, so curve_fit uses Levenberg-Marquardt, as the page does.');
  }
  if (hasSigma) {
    L.push(absoluteSigma
      ? `# absolute_sigma=True: ${errName} holds true standard deviations, so the errors are not rescaled.`
      : `# absolute_sigma=False: ${errName} sets relative weights; the errors are scaled to the scatter.`);
  }
  const fitArgs = [F, xdata, dep, 'p0=p0'];
  if (bounded) fitArgs.push('bounds=bounds');
  if (hasSigma) fitArgs.push(`sigma=${errName}`, `absolute_sigma=${absoluteSigma ? 'True' : 'False'}`);
  fitArgs.push('maxfev=20000');
  L.push(...pyCall('popt, pcov = curve_fit', fitArgs));
  if (spec.fit && Array.isArray(spec.fit.parameters) && spec.fit.parameters.length) {
    L.push('# The page found these values; the report below should print the same:');
    spec.fit.parameters.forEach((p) => {
      const nm = names.get(p.name) || comment(p.name);
      const isFixed = params.some((q) => q.name === p.name && q.fixed);
      const err = Number(p.stderr);
      const tail = isFixed ? ' (fixed)' : (Number.isFinite(err) ? ` ± ${short(err, 4)}` : '');
      L.push(`#   ${nm} = ${short(p.value)}${tail}`);
    });
    if (Number.isFinite(Number(spec.fit.r2))) L.push(`#   R² = ${short(spec.fit.r2)}`);
  }
  blank();
  L.push(`fitted = ${F}(${xdata}, *popt)`);
  L.push(`residuals = ${dep} - fitted`);
  L.push('perr = np.sqrt(np.diag(pcov))       # standard errors');
  L.push(`n_points, n_free = len(${dep}), len(popt)`);
  L.push('dof = n_points - n_free             # degrees of freedom');
  L.push('t_crit = stats.t.ppf(0.975, dof)    # for two-sided 95% intervals');
  L.push('ss_res = np.sum(residuals**2)');
  if (hasSigma) {
    L.push('# With uncertainties, R² is weighted as the fit is: 1 - chi²/(weighted total).');
    L.push(`weights = 1/${errName}**2`);
    L.push(`chi2 = np.sum(weights*residuals**2)`);
    L.push(`weighted_mean = np.sum(weights*${dep})/np.sum(weights)`);
    L.push(`r_squared = 1 - chi2/np.sum(weights*(${dep} - weighted_mean)**2)`);
  } else {
    L.push(`r_squared = 1 - ss_res/np.sum((${dep} - np.mean(${dep}))**2)`);
  }
  L.push('rmse = np.sqrt(ss_res/n_points)             # unweighted, in the units of the data');
  if (hasSigma) L.push('chi2_red = chi2/dof');
  blank();

  /* Report */
  const w = Math.max(9, ...params.map((p) => pn(p).length));
  L.push(`print(${pyStr('Fit of ' + eqText)}, f'to {n_points} points')`);
  L.push(`print(f"{'Parameter':<${w}}  {'Value':>13} ± {'Std. error':<12}  95% confidence interval")`);
  L.push(`for name, value, err in zip([${free.map((p) => pyStr(pn(p))).join(', ')}], popt, perr):`);
  L.push(`    print(f'{name:<${w}}  {value:>13.6g} ± {err:<12.6g}  [{value - t_crit*err:.6g}, {value + t_crit*err:.6g}]')`);
  fixedParams.forEach((p) => {
    // Double quotes outside: Python before 3.12 cannot reuse the quote inside.
    L.push(`print(f"{${pyStr(pn(p))}:<${w}}  {fixed[${pyStr(pn(p))}]:>13.6g}   (fixed)")`);
  });
  L.push(`print(f'R²   {r_squared:.6g}')`);
  L.push(`print(f'RMSE {rmse:.6g}')`);
  if (hasSigma) L.push(`print(f'Reduced chi-squared {chi2_red:.6g}')`);
  blank();

  const band = s.band.show && !multi;
  if (band) {
    blank();
    L.push(`def confidence_band(x, level):`);
    L.push('    """Half-width of the confidence band of the fitted curve at x.');
    L.push('');
    L.push('    The delta method: the gradient of the model with respect to the free');
    L.push('    parameters, by central differences, carried through their covariance.');
    L.push('    """');
    L.push('    grad = np.empty((len(popt), np.size(x)))');
    L.push('    for i, value in enumerate(popt):');
    L.push('        h = np.cbrt(np.finfo(float).eps) * (abs(value) if value != 0 else 1.0)');
    L.push('        up, down = popt.copy(), popt.copy()');
    L.push('        up[i] += h');
    L.push('        down[i] -= h');
    L.push(`        grad[i] = (${F}(x, *up) - ${F}(x, *down)) / (2*h)`);
    L.push("    se = np.sqrt(np.einsum('ik,ij,jk->k', grad, pcov, grad))");
    L.push('    return stats.t.ppf((1 + level)/2, dof) * se');
    blank();
    blank();
  }

  /* Figure */
  figureLines(L, { s, multi, F, dep, x0, xs, errName, hasSigma, band, section });

  /* Save */
  saveLines(L, s, section);
  return L.join('\n') + '\n';
}

/** A cell as the page reads it: numbers as they are, text trimmed, anything else missing. */
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim() === '' ? NaN : Number(v.trim());
  return NaN;
}

function isNum(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

function finiteOr(v, fallback) {
  return isNum(v) ? Number(v) : fallback;
}

/** `v` moved inside the parameter's bounds. */
function clampTo(p, v) {
  return Math.min(finiteOr(p.max, Infinity), Math.max(finiteOr(p.min, -Infinity), v));
}

/* ------------------------------------------------------------------ *
 * The figure
 * ------------------------------------------------------------------ */

function figureLines(L, ctx) {
  const { s, multi, F, dep, x0, errName, hasSigma, band, section } = ctx;
  const blank = () => L.push('');
  const residualsPanel = s.residuals.show;
  const bottom = residualsPanel ? 'ax_res' : 'ax';

  section('Figure');
  rcLines(L, s);
  blank();

  if (residualsPanel) {
    L.push(`# The fit above, the residuals below: the lower panel is ${short(s.residuals.heightRatio)} times as tall.`);
  }
  subplotsLines(L, s, residualsPanel ? ['ax', 'ax_res'] : ['ax'], [1, s.residuals.heightRatio]);
  blank();

  const handles = [];
  const markerOn = s.data.marker !== 'none';
  const errorBars = s.data.errorBars && hasSigma;
  const points = {
    kind: errorBars ? 'errorbar' : 'scatter', marker: s.data.marker, size: s.data.size, color: s.data.color,
    edgeColor: s.data.edgeColor, edgeWidth: s.data.edgeWidth, alpha: s.data.alpha, errorWidth: s.data.errorWidth,
    capSize: s.data.capSize, label: s.data.label, lineStyle: 'none'
  };
  // The residual panel shows its points even when the data above are hidden:
  // it exists to show them.
  const dataArtist = (target, xv, yv, withLabel, handle) => {
    const shown = s.data.show || target === 'ax_res';
    if (!shown) return;
    if (!errorBars && !markerOn) {
      L.push('# Markers are off and there are no error bars, so the points are not drawn.');
      return;
    }
    seriesLines(L, points, target, { x: xv, y: yv, yerr: errorBars ? errName : null, handle, markerName: 'residual_points', labelled: withLabel, zorder: 3 });
    if (withLabel && s.data.label && handle) handles.push(handle);
  };

  const fitLine = { kind: 'line', color: s.fit.color, lineWidth: s.fit.width, lineStyle: s.fit.style, marker: 'none', alpha: 1, label: s.fit.label };
  const zeroLine = { ...fitLine, kind: 'hline', y: 0, label: '' };

  if (!multi) {
    // Where to draw the curve: across the data, or across the x limits if set.
    const log = s.xScale === 'log';
    const [lim0, lim1] = s.xLim.map((v) => (v !== null && log && v <= 0 ? null : v));
    const dataLo = log ? `${x0}[${x0} > 0].min()` : `${x0}.min()`;
    const lo = lim0 !== null ? pyNum(lim0) : dataLo;
    const hi = lim1 !== null ? pyNum(lim1) : `${x0}.max()`;
    const across = lim0 !== null && lim1 !== null ? 'between the x limits' : lim0 !== null || lim1 !== null ? 'from the x limit to the data' : 'across the data';
    if (s.fit.show || band) {
      L.push(`# The fitted curve at ${s.fit.samples} points ${across}${log ? ', evenly spaced in log x' : ''}.`);
      L.push(`x_fit = np.${log ? 'geomspace' : 'linspace'}(${lo}, ${hi}, ${s.fit.samples})`);
      L.push(`y_fit = ${F}(x_fit, *popt)`);
    }
    if (band) {
      const pct = short(s.band.level * 100, 4);
      L.push(`half = confidence_band(x_fit, ${pyNum(s.band.level)})  # the ${pct}% confidence band`);
      seriesLines(L, { kind: 'band', color: s.band.color, alpha: s.band.alpha, edgeWidth: 0, label: s.band.label || `${pct}% confidence band` }, 'ax',
        { x: 'x_fit', lower: 'y_fit - half', upper: 'y_fit + half', handle: 'band', labelled: true, zorder: 1 });
    }
    if (s.fit.show) {
      seriesLines(L, fitLine, 'ax', { x: 'x_fit', y: 'y_fit', handle: 'fit_line', labelled: !!s.fit.label, zorder: 2 });
      if (s.fit.label) handles.push('fit_line');
    }
    if (band) handles.push('band');
    dataArtist('ax', x0, dep, true, 'data_points');
    if (residualsPanel) {
      blank();
      L.push('# Residuals, observed minus fitted, about the zero line.');
      seriesLines(L, zeroLine, 'ax_res', { zorder: 2 });
      dataArtist('ax_res', x0, 'residuals', false, null);
      L.push("ax_res.set_ylabel('Residual')");
    }
  } else {
    L.push(`# With several independent variables (${ctx.xs.join(', ')}) there is no single curve to`);
    L.push('# draw, so the plot shows each observed value against the model\'s prediction,');
    L.push('# with the diagonal where a perfect fit would put every point.');
    L.push('predicted = fitted');
    const logX = s.xScale === 'log', logY = s.yScale === 'log';
    L.push(`both = np.concatenate([predicted, ${dep}])`);
    if (logX || logY) L.push('both = both[both > 0]  # a log axis shows only positive values');
    const lo = s.xLim[0] !== null && !(logX && s.xLim[0] <= 0) ? pyNum(s.xLim[0]) : 'both.min()';
    const hi = s.xLim[1] !== null ? pyNum(s.xLim[1]) : 'both.max()';
    if (s.fit.show) {
      L.push(`line = np.${logX ? 'geomspace' : 'linspace'}(${lo}, ${hi}, ${s.fit.samples})`);
      seriesLines(L, fitLine, 'ax', { x: 'line', y: 'line', handle: 'fit_line', labelled: !!s.fit.label, zorder: 2 });
      if (s.fit.label) handles.push('fit_line');
    }
    if (s.band.show) L.push('# (No confidence band: it belongs to a curve over one variable.)');
    dataArtist('ax', 'predicted', dep, true, 'data_points');
    if (residualsPanel) {
      blank();
      L.push('# Residuals, observed minus predicted, against the prediction.');
      seriesLines(L, zeroLine, 'ax_res', { zorder: 2 });
      dataArtist('ax_res', 'predicted', 'residuals', false, null);
      L.push("ax_res.set_ylabel('Residual')");
    }
  }
  // Keep the legend in drawing order: data, fit, band.
  const order = ['data_points', 'fit_line', 'band'];
  handles.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  blank();

  /* Log scales, once everything is drawn */
  if (s.xScale === 'log' || s.yScale === 'log') {
    scaleComment(L);
    if (s.xScale === 'log') L.push("ax.set_xscale('log')");
    if (s.yScale === 'log') L.push("ax.set_yscale('log')");
    blank();
  }

  /* Axes */
  L.push('# Axes');
  if (s.title) L.push(`ax.set_title(${pyStr(s.title)})`);
  L.push(`${bottom}.set_xlabel(${pyStr(s.xLabel)})`);
  L.push(`ax.set_ylabel(${pyStr(s.yLabel)})`);
  const limLine = (k, lim, log) => {
    const [a, b] = lim.map((v) => (v !== null && log && v <= 0 ? null : v));
    if (a === null && b === null) return;
    L.push(`ax.set_${k}lim(${a === null ? 'None' : pyNum(a)}, ${b === null ? 'None' : pyNum(b)})${a === null || b === null ? '  # None: automatic' : ''}`);
  };
  limLine('x', s.xLim, s.xScale === 'log');
  limLine('y', s.yLim, s.yScale === 'log');
  blank();

  ['x', 'y'].forEach((k) => tickLines(L, {
    k, axis: `ax.${k}axis`, T: s[`${k}Ticks`], log: s[`${k}Scale`] === 'log',
    note: k === 'x' && residualsPanel ? ' (shared by both panels)' : '',
    minorAlso: k === 'y' && residualsPanel ? ['ax_res.yaxis'] : [],
    gridMinor: s.grid.show && s.grid.minor && gridOn(s, k)
  }));

  /* Frame, ticks, grid, for each panel */
  L.push('# Background, frame, tick marks and grid, for each panel.');
  L.push('for axes in fig.axes:');
  frameBody(L, s, { x: s.xTicks, y: s.yTicks, xLog: s.xScale === 'log', yLog: s.yScale === 'log' });
  blank();

  /* Legend */
  if (s.legend.show && handles.length) {
    L.push('# Legend');
    legendCall(L, s, 'ax', handles);
  } else if (s.legend.show) {
    L.push('# (No legend: nothing drawn has a label.)');
  } else {
    L.pop(); // the blank line kept for the legend
  }
}
