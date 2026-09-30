/**
 * @module core/xvg-parser
 *
 * Pure parsing and data-extraction routines for GROMACS/Grace `.xvg` files
 * and generic whitespace/comma-delimited numerical tables.
 *
 * This module is deliberately free of any DOM, browser, or UI dependency so
 * that it can be consumed identically by a browser bundle, by Node.js, or by
 * a headless test runner.
 *
 * Format reference: GROMACS writes Grace/xmgrace-compatible files in which
 *   - lines beginning with '#' are free-form comments,
 *   - lines beginning with '@' are Grace formatting directives
 *     (title, xaxis label, yaxis label, sN legend, ...),
 *   - all remaining non-empty lines are whitespace-delimited numeric records.
 *
 * A CSV may instead open with a header row naming its columns. That row is
 * recognised when it sits directly above the first numeric record and has as
 * many fields as the file's records; its names then label the columns. A line
 * that is only '&' ends one Grace data set; the rows of every set are read
 * into one matrix, in file order. Every record must have the number of fields
 * most of the numeric records have; a longer or shorter row is rejected rather
 * than padded or truncated.
 *
 * The figure the XVG Visualizer draws is described here too (xvgFigure, in
 * the shared figure description of figure.js), with the matplotlib script
 * that draws it from the person's file (xvgFigureScript), so the page and
 * its tests build the same figure.
 */

import { normaliseFigure, colorCycle } from './figure.js';
import { figureScript, identifier, pyArray, pyCall, pyStr, comment } from './figure-python.js';

/** Default colour palette used for series assignment (UI-agnostic hex list). */
export const COLOR_PALETTE = Object.freeze([
  '#2563eb', '#ef4444', '#10b981', '#f59e0b',
  '#8b5cf6', '#06b6d4', '#ec4899'
]);

/**
 * Extract the first double-quoted substring from a Grace directive line.
 *
 * @param {string} line - A single '@' directive line.
 * @returns {string|null} The quoted value, or null when no closed pair exists.
 */
export function extractQuoted(line) {
  if (typeof line !== 'string') return null;
  const match = line.match(/"([^"]*)"/);
  return match ? match[1] : null;
}

/**
 * Parse a single Grace '@' metadata directive and fold it into a metadata
 * accumulator. Unrecognised directives are ignored silently, which mirrors the
 * permissive behaviour of xmgrace itself.
 *
 * Tolerates arbitrary internal whitespace, e.g. both
 *   `@    xaxis  label "Time (ps)"` and `@ xaxis label "Time (ps)"`.
 *
 * @param {string} line - The raw directive line (leading '@' included).
 * @param {{title:string|null,xAxisLabel:string|null,yAxisLabel:string|null,legends:Object<number,string>}} meta
 *        Mutable accumulator, updated in place.
 * @returns {boolean} True when the directive was recognised and consumed.
 */
export function parseMetadataLine(line, meta) {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (!trimmed.startsWith('@')) return false;

  const body = trimmed.slice(1).trim();
  const value = extractQuoted(body);

  // `@ sN legend "..."` -> series legend for data column N+1
  const legendMatch = body.match(/^s(\d+)\s+legend\b/i);
  if (legendMatch && value !== null) {
    meta.legends[Number(legendMatch[1])] = value;
    return true;
  }

  if (/^xaxis\s+label\b/i.test(body)) {
    if (value !== null) meta.xAxisLabel = value;
    return true;
  }

  if (/^yaxis\s+label\b/i.test(body)) {
    if (value !== null) meta.yAxisLabel = value;
    return true;
  }

  if (/^title\b/i.test(body)) {
    if (value !== null) meta.title = value;
    return true;
  }

  return false;
}

/**
 * Tokenise a data record into finite numbers.
 *
 * A record is accepted only if *every* token converts to a finite number;
 * partially numeric lines (stray text, NaN, Infinity) are rejected outright so
 * that malformed records never silently contaminate a trajectory.
 *
 * A line containing a comma is split on commas alone, and an empty field
 * rejects the record in the same way. Collapsing it instead would move every
 * later value one column to the left, so a series would silently take its
 * numbers from the wrong column.
 *
 * @param {string} line - A single data line.
 * @returns {number[]|null} The numeric row, or null when the line is not a
 *          valid all-numeric record.
 */
export function parseDataLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const tokens = trimmed.includes(',')
    ? trimmed.split(',').map(t => t.trim())
    : trimmed.split(/\s+/);

  const row = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '') return null;
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) return null;
    row[i] = n;
  }
  return row;
}

/**
 * Resolve final column headers from parsed Grace legends and axis labels.
 *
 * Column 0 is conventionally the abscissa and inherits the x-axis label;
 * column k (k >= 1) inherits legend `s(k-1)` when present, then the name from
 * a CSV header row, otherwise a deterministic fallback name.
 *
 * @param {number} colCount - Number of columns in the numeric matrix.
 * @param {Object<number,string>} legends - Legend map keyed by Grace series index.
 * @param {string} xAxisLabel - Resolved x-axis label.
 * @param {string[]} [names] - Column names from a header row, if the file has one.
 * @returns {string[]} Header array of length `colCount`.
 */
export function resolveHeaders(colCount, legends = {}, xAxisLabel = 'X', names = []) {
  const headers = new Array(Math.max(0, colCount));
  for (let c = 0; c < headers.length; c++) {
    const legend = legends[c - 1];
    const name = Array.isArray(names) ? names[c] : undefined;
    if (c >= 1 && typeof legend === 'string' && legend.length > 0) {
      headers[c] = legend;
    } else if (c >= 1 && typeof name === 'string' && name.length > 0) {
      headers[c] = name;
    } else if (c === 0) {
      headers[c] = xAxisLabel || 'X';
    } else {
      headers[c] = `Dataset ${c}`;
    }
  }
  return headers;
}

/**
 * Split a header row into column names, dropping quotes around each name.
 *
 * @param {string} line
 * @param {string|null} delimiter - ',' for a CSV, null for whitespace.
 * @returns {string[]}
 */
function splitHeaderRow(line, delimiter) {
  const fields = delimiter === ',' ? line.split(',') : line.split(/\s+/);
  while (fields.length && fields[fields.length - 1].trim() === '') fields.pop();
  return fields.map(f => f.trim().replace(/^(["'])(.*)\1$/, '$2').trim());
}

/**
 * Whether every numeric line of a file ends with a comma.
 *
 * Some programs end each CSV row with the delimiter. When every numeric line
 * does so, the empty field after it is an artefact of the export, not a
 * missing value, and is dropped. One numeric line without it means the commas
 * mark real gaps, and those records stay rejected.
 *
 * @param {string[]} lines - The file's lines.
 * @returns {boolean}
 */
function hasTrailingDelimiter(lines) {
  let found = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line[0] === '@' || line[0] === '#' || line === '&') continue;
    if (parseDataLine(line)) return false;
    if (line.endsWith(',') && parseDataLine(line.slice(0, -1))) found = true;
  }
  return found;
}

/**
 * Parse a complete `.xvg` (or generic delimited numeric) buffer.
 *
 * `colCount` is the number of fields that most numeric records have (ties go
 * to the width seen first), and the header row is only adopted when it has
 * the same number. A record with a different number is rejected and counted,
 * because a short or long row cannot be placed in the columns without guessing
 * which value is missing. Taking the most common width rather than the first
 * means one malformed opening line cannot reject the rest of the file.
 *
 * `delimiter`, `skipRows` and `strayLines` describe the file for
 * `numpy.loadtxt`: the delimiter is ',' when the records are comma-separated
 * (null means whitespace, NumPy's default), `skipRows` counts the lines before
 * the first record whenever any of them was rejected, such as a CSV header
 * row, and `strayLines` counts the rejected lines found after the first
 * record, which
 * `loadtxt` would otherwise stop at. `trailingDelimiter` is true when every
 * numeric line ends with a comma and that last empty field was dropped.
 * `labels` holds the title and axis labels the file's '@' lines give, each
 * null when the file gives none.
 *
 * @param {string} rawText - Full file contents.
 * @param {{fallbackTitle?: string}} [options]
 * @returns {{
 *   matrix: number[][],
 *   headers: string[],
 *   colCount: number,
 *   rowCount: number,
 *   title: string,
 *   xAxisLabel: string,
 *   yAxisLabel: string,
 *   skippedLines: number,
 *   delimiter: string|null,
 *   skipRows: number,
 *   strayLines: number,
 *   trailingDelimiter: boolean,
 *   labels: {title: string|null, x: string|null, y: string|null}
 * }}
 */
export function parseXvg(rawText, options = {}) {
  const { fallbackTitle = 'Log Data' } = options;

  const meta = { title: null, xAxisLabel: null, yAxisLabel: null, legends: {} };
  const matrix = [];
  let colCount = 0;
  let skippedLines = 0;
  let delimiter = null;
  let skipRows = 0;
  let strayLines = 0;
  let names = [];
  // The last text line before any numeric line: a header candidate.
  let headerLine = null;
  let sawNumeric = false;
  let rejectedBefore = false;

  const text = typeof rawText === 'string' ? rawText : '';
  const lines = text.split(/\r\n|\r|\n/);
  const trailingDelimiter = hasTrailingDelimiter(lines);

  // First pass: parse every candidate record and find the most common width.
  const parsed = new Array(lines.length).fill(null);
  const widths = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line[0] === '@' || line[0] === '#' || line === '&') continue;
    const body = trailingDelimiter && line.endsWith(',') ? line.slice(0, -1) : line;
    const row = parseDataLine(body);
    if (row === null) continue;
    parsed[i] = row;
    widths.set(row.length, (widths.get(row.length) || 0) + 1);
  }
  // Map iteration follows insertion order, so a tie keeps the width seen first.
  let most = 0;
  for (const [w, n] of widths) {
    if (n > most) { most = n; colCount = w; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;

    if (line.startsWith('@')) {
      parseMetadataLine(line, meta);
      continue;
    }
    if (line.startsWith('#')) continue;
    // Grace multi-set separator; not a data record.
    if (line === '&') continue;

    const row = parsed[i];
    if (row === null || row.length !== colCount) {
      skippedLines++;
      if (matrix.length > 0) strayLines++;
      else rejectedBefore = true;
      if (row === null && !sawNumeric) headerLine = line;
      if (row !== null) sawNumeric = true;
      continue;
    }
    sawNumeric = true;
    if (matrix.length === 0) {
      delimiter = line.includes(',') ? ',' : null;
      if (rejectedBefore) skipRows = i;
      if (headerLine !== null) {
        // A header names at least one column in words; a line that is numbers
        // apart from empty fields is a malformed record instead.
        const fields = splitHeaderRow(headerLine, delimiter);
        const named = fields.some(f => f !== '' && !Number.isFinite(Number(f)));
        if (fields.length === colCount && named) {
          names = fields;
          skippedLines--;
        }
      }
    }
    matrix.push(row);
  }

  const xAxisLabel = meta.xAxisLabel || names[0] || 'X';
  const yAxisLabel = meta.yAxisLabel || 'Y';
  const headers = resolveHeaders(colCount, meta.legends, xAxisLabel, names);

  return {
    matrix,
    headers,
    colCount,
    rowCount: matrix.length,
    title: meta.title || fallbackTitle,
    xAxisLabel,
    yAxisLabel,
    skippedLines,
    delimiter,
    skipRows,
    strayLines,
    trailingDelimiter,
    // What the file itself says, null where it says nothing (the fields
    // above fill those gaps with the file name, 'X' and 'Y').
    labels: { title: meta.title, x: meta.xAxisLabel, y: meta.yAxisLabel }
  };
}

/**
 * Extract a single column from a parsed matrix.
 *
 * @param {number[][]} matrix
 * @param {number} index - Zero-based column index.
 * @returns {Array<number|undefined>} Column values; `undefined` for short rows.
 */
export function extractColumn(matrix, index) {
  if (!Array.isArray(matrix)) return [];
  if (!Number.isInteger(index) || index < 0) return [];
  return matrix.map(row => (Array.isArray(row) ? row[index] : undefined));
}

/**
 * Extract an (x, y) series pair, discarding records in which either coordinate
 * is absent or non-finite. Pairing is preserved: index i of `x` always
 * corresponds to index i of `y`.
 *
 * @param {number[][]} matrix
 * @param {number} xIndex
 * @param {number} yIndex
 * @returns {{x: number[], y: number[]}}
 */
export function extractSeries(matrix, xIndex, yIndex) {
  const x = [];
  const y = [];
  if (!Array.isArray(matrix)) return { x, y };

  for (const row of matrix) {
    if (!Array.isArray(row)) continue;
    const xv = row[xIndex];
    const yv = row[yIndex];
    if (Number.isFinite(xv) && Number.isFinite(yv)) {
      x.push(xv);
      y.push(yv);
    }
  }
  return { x, y };
}

/**
 * Choose the default set of ordinate columns to display.
 *
 * Wide files (more than four columns) default to the first two data columns to
 * keep the initial render legible; narrower files show every data column.
 *
 * @param {number} colCount
 * @returns {number[]} Sorted, zero-based column indices (never includes 0).
 */
export function defaultActiveColumns(colCount) {
  if (!Number.isFinite(colCount) || colCount < 2) return [];
  const limit = colCount > 4 ? 3 : colCount;
  const out = [];
  for (let i = 1; i < limit; i++) out.push(i);
  return out;
}

/**
 * Compute descriptive statistics for a numeric column.
 *
 * The variance uses the unbiased (Bessel-corrected, n-1) estimator, matching
 * `numpy.std(..., ddof=1)` and the convention used throughout STEMKit.
 * Non-finite entries are excluded before computation.
 *
 * @param {Array<number|undefined>} values
 * @returns {{n:number, min:number, max:number, mean:number, std:number}|null}
 *          Null when no finite values are present.
 */
export function columnStats(values) {
  if (!Array.isArray(values)) return null;
  const clean = values.filter(Number.isFinite);
  const n = clean.length;
  if (n === 0) return null;

  let min = clean[0];
  let max = clean[0];
  let sum = 0;
  for (const v of clean) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / n;

  let sq = 0;
  for (const v of clean) {
    const d = v - mean;
    sq += d * d;
  }
  const std = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;

  return { n, min, max, mean, std };
}

/**
 * Generate a synthetic GROMACS-style `.xvg` buffer (RMSD + radius of gyration).
 *
 * A deterministic linear congruential generator is used instead of `Math.random`
 * so that the sample is byte-for-byte reproducible for a given seed, a
 * requirement for using the sample in regression tests and documentation.
 *
 * @param {{tMax?:number, dt?:number, seed?:number}} [options]
 * @returns {string} A valid `.xvg` document.
 */
export function generateSampleXvg(options = {}) {
  const { tMax = 1000, dt = 10, seed = 42 } = options;

  let s = seed >>> 0;
  const rand = () => {
    // Numerical Recipes LCG; returns a value in [0, 1).
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };

  let xvg = '# Synthetic sample generated by STEMKit\n';
  xvg += '@    title "RMSD & Radius of Gyration"\n';
  xvg += '@    xaxis  label "Time (ps)"\n';
  xvg += '@    yaxis  label "nm"\n';
  xvg += '@ s0 legend "Backbone RMSD"\n';
  xvg += '@ s1 legend "Rg"\n';

  for (let t = 0; t <= tMax; t += dt) {
    const rmsd = (0.12 + 0.08 * (1 - Math.exp(-t / 200)) + (rand() - 0.5) * 0.02).toFixed(4);
    const rg = (1.85 + 0.05 * Math.sin(t / 120) + (rand() - 0.5) * 0.01).toFixed(4);
    xvg += `${t.toFixed(1)}   ${rmsd}   ${rg}\n`;
  }
  return xvg;
}

/**
 * Escape a JavaScript string for safe embedding in single-quoted Python source.
 *
 * @param {*} value
 * @returns {string} A quoted Python string literal.
 */
export function pythonLiteral(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/**
 * Emit a standalone, runnable matplotlib script that reproduces the current
 * plot from the original `.xvg` file. This is the reproducibility bridge: the
 * figure a user sees in the browser can be regenerated offline, unchanged.
 *
 * `delimiter`, `skipRows` and `strayLines` come from `parseXvg`, so a CSV is
 * read with `delimiter=','` and its header row is skipped rather than parsed
 * as numbers. `comments` covers the '@' and '#' lines and the '&' that ends a
 * Grace data set, so the sets are read one after another, as the parser reads
 * them. When the parser rejected lines among the numeric records, the script
 * instead passes `loadtxt` only the lines the parser kept: `colCount` numbers
 * each, with a trailing comma dropped when `trailingDelimiter` is set. A
 * trailing comma also brings `usecols`, so NumPy ignores the empty last field.
 *
 * @param {{
 *   headers?: string[], xIndex?: number, yIndices?: number[],
 *   title?: string, xAxisLabel?: string, yAxisLabel?: string,
 *   showMarkers?: boolean, logY?: boolean, filename?: string,
 *   delimiter?: string|null, skipRows?: number, strayLines?: number,
 *   colCount?: number, trailingDelimiter?: boolean
 * }} config
 * @returns {string} Python source code.
 */
export function generateMatplotlibCode(config = {}) {
  const {
    headers = [],
    xIndex = 0,
    yIndices = [],
    title = '',
    xAxisLabel = 'x',
    yAxisLabel = 'y',
    showMarkers = false,
    logY = false,
    filename = 'your_file.xvg',
    delimiter = null,
    skipRows = 0,
    strayLines = 0,
    colCount = 0,
    trailingDelimiter = false
  } = config;

  if (!Array.isArray(yIndices) || yIndices.length === 0) {
    return '# Load a file and select at least one Y column, then click Python again.';
  }

  const py = pythonLiteral;
  let c = 'import matplotlib.pyplot as plt\nimport numpy as np\n\n';
  const width = Number.isInteger(colCount) && colCount > 0 ? colCount : 0;
  const trailing = Boolean(trailingDelimiter) && width > 0;
  const sep = (delimiter ? `, delimiter=${py(delimiter)}` : '') +
              (trailing ? `, usecols=range(${width})` : '');
  if (strayLines > 0) {
    // Text or ragged rows among the numbers would stop loadtxt, so the script
    // applies the parser's rule itself: a line is data only if it holds the
    // file's number of fields and every one is a number.
    c += '# --- Load your file: only the rows the page plotted' +
         `${width ? `, ${width} numbers each` : ''} ---\n`;
    c += 'def is_record(line):\n';
    if (trailing) {
      c += '    line = line.strip()\n';
      c += "    if line.endswith(','):  # each row ends with a comma; not a value\n";
      c += '        line = line[:-1]\n';
    }
    c += "    fields = line.split(',') if ',' in line else line.split()\n";
    c += '    try:\n';
    c += `        return ${width ? `len(fields) == ${width}` : 'bool(fields)'} and ` +
         'all(np.isfinite(float(f)) for f in fields)\n';
    c += '    except ValueError:\n';
    c += '        return False\n\n';
    c += `with open(${py(filename)}) as f:\n`;
    c += `    data = np.loadtxt([line for line in f if is_record(line)]${sep})\n`;
  } else {
    const rows = Number.isInteger(skipRows) && skipRows > 0 ? skipRows : 0;
    if (delimiter === ',' || rows) {
      const skip = rows === 1 ? 'the first line' : `the first ${rows} lines`;
      c += `# --- Load your file (${delimiter === ',' ? 'comma-separated; ' : ''}` +
           `skips ${rows ? skip + ' and ' : ''}@/#/& lines) ---\n`;
    } else {
      c += '# --- Load your .xvg (skips GROMACS @/# metadata lines and & set breaks) ---\n';
    }
    c += `data = np.loadtxt(${py(filename)}${sep}${rows ? `, skiprows=${rows}` : ''}, ` +
         "comments=['@', '#', '&'])\n";
  }
  c += `# Columns: ${xIndex} = ${headers[xIndex] || 'x'}`;
  c += yIndices.map(i => `, ${i} = ${headers[i] || 'y' + i}`).join('');
  c += '\n\n';
  c += `x = data[:, ${xIndex}]\n\n`;
  c += 'fig, ax = plt.subplots(figsize=(8, 5), dpi=150)\n';

  for (const i of yIndices) {
    const color = COLOR_PALETTE[i % COLOR_PALETTE.length];
    const label = headers[i] || `Dataset ${i}`;
    const style = showMarkers ? ", marker='o', markersize=3" : '';
    c += `ax.plot(x, data[:, ${i}], color='${color}', lw=1.5${style}, label=${py(label)})\n`;
  }

  c += `\nax.set_xlabel(${py(headers[xIndex] || xAxisLabel || 'x')})\n`;
  c += `ax.set_ylabel(${py(yAxisLabel || 'y')})\n`;
  if (title) c += `ax.set_title(${py(title)})\n`;
  if (logY) c += "ax.set_yscale('log')\n";
  c += 'ax.legend(frameon=True)\n';
  c += "ax.spines['top'].set_visible(False)\nax.spines['right'].set_visible(False)\n";
  c += "fig.tight_layout()\nfig.savefig('plot.png', dpi=300, bbox_inches='tight')\nplt.show()\n";
  return c;
}

/* ------------------------------------------------------------------ *
 * Grace text in labels
 * ------------------------------------------------------------------ */

/*
 * Grace, and so GROMACS, writes a Greek letter as a letter of the Symbol
 * font after \x (back to the normal font at \f{}), and raises or lowers text
 * between \S or \s and \N: "Rg\sX\N", "Area (nm\S2\N)", "\xD\f{}G".
 */
const GRACE_GREEK = Object.freeze({
  a: 'alpha', b: 'beta', c: 'chi', d: 'delta', e: 'epsilon', f: 'phi', g: 'gamma', h: 'eta', i: 'iota',
  j: 'varphi', k: 'kappa', l: 'lambda', m: 'mu', n: 'nu', p: 'pi', q: 'theta', r: 'rho', s: 'sigma',
  t: 'tau', u: 'upsilon', w: 'omega', x: 'xi', y: 'psi', z: 'zeta',
  D: 'Delta', F: 'Phi', G: 'Gamma', L: 'Lambda', P: 'Pi', Q: 'Theta', S: 'Sigma', U: 'Upsilon',
  W: 'Omega', X: 'Xi', Y: 'Psi'
});
const GREEK_LETTERS = Object.freeze({
  alpha: 'α', beta: 'β', chi: 'χ', delta: 'δ', epsilon: 'ε', phi: 'ϕ', gamma: 'γ', eta: 'η', iota: 'ι',
  varphi: 'φ', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', pi: 'π', theta: 'θ', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', omega: 'ω', xi: 'ξ', psi: 'ψ', zeta: 'ζ', Delta: 'Δ', Phi: 'Φ', Gamma: 'Γ',
  Lambda: 'Λ', Pi: 'Π', Theta: 'Θ', Sigma: 'Σ', Upsilon: 'Υ', Omega: 'Ω', Xi: 'Ξ', Psi: 'Ψ'
});

/* Grace text as runs: { text, greek, shift: '' | 'sup' | 'sub' }. */
function graceRuns(text) {
  const s = String(text ?? '');
  const runs = [];
  let shift = '';
  let greek = false;
  const add = (ch, isGreek) => {
    const last = runs[runs.length - 1];
    if (last && last.shift === shift && last.greek === isGreek) last.text.push(ch);
    else runs.push({ text: [ch], greek: isGreek, shift });
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\' || i + 1 >= s.length) {
      add(ch, greek && Object.prototype.hasOwnProperty.call(GRACE_GREEK, ch));
      continue;
    }
    const code = s[++i];
    if (code === '\\') add('\\', false);
    else if (code === 'x') greek = true;
    else if (code === 'S') shift = 'sup';
    else if (code === 's') shift = 'sub';
    else if (code === 'N') shift = '';
    else if (code === 'f') {
      // \f{name}, \f{} or \fN: another font, so no longer the Symbol font.
      if (s[i + 1] === '{') { const end = s.indexOf('}', i + 1); i = end < 0 ? s.length : end; } else i++;
      greek = false;
    } else if (/[0-9]/.test(code)) greek = false;
    else if (code === '#' && s[i + 1] === '{') {
      const end = s.indexOf('}', i + 1);
      const cp = parseInt(s.slice(i + 2, end < 0 ? s.length : end), 16);
      if (Number.isFinite(cp)) add(String.fromCodePoint(cp), false);
      i = end < 0 ? s.length : end;
    } else if (/[RCTZrtmh]/.test(code) && s[i + 1] === '{') {
      // Colour, transform, zoom and move commands with an argument: dropped.
      const end = s.indexOf('}', i + 1);
      i = end < 0 ? s.length : end;
    } else if (!/[+\-uUoOqQlL]/.test(code)) {
      // Not Grace's: kept as typed. (Size, underline, overline and slant
      // change only the look, and are dropped.)
      add('\\', false);
      add(code, false);
    }
  }
  return runs.map((r) => ({ ...r, text: r.text.join('') }));
}

const TEX_SPECIAL = /[\\{}_^$#%&~]/g;

/* Text already written for matplotlib: an even number of unescaped $ signs. */
function isMathText(s) {
  const n = (s.match(/\$/g) || []).length - (s.match(/\\\$/g) || []).length;
  return n > 0 && n % 2 === 0;
}

/**
 * A label written with Grace's escapes (GROMACS's "Rg\sX\N", "nm\S2\N",
 * "\xD\f{}G") as matplotlib text: sub- and superscripts and Greek letters
 * as mathematics between $ signs, the rest as typed. Text without a
 * backslash, or already written for matplotlib ($\tau$), is returned as it is.
 *
 * @param {string} text
 * @returns {string}
 */
export function graceToTex(text) {
  const s = String(text ?? '');
  if (!s.includes('\\') || isMathText(s)) return s;
  const runs = graceRuns(s);
  if (!runs.some((r) => r.greek || r.shift)) return runs.map((r) => r.text).join('');
  const math = (r) => {
    if (r.greek) return Array.from(r.text, (ch) => `\\${GRACE_GREEK[ch]}`).join('');
    return r.text.replace(TEX_SPECIAL, (c) => `\\${c}`).replace(/ /g, '\\ ');
  };
  const parts = [];
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    if (!r.greek && !r.shift) { parts.push({ math: false, text: r.text.replace(/\$/g, '\\$') }); continue; }
    // A script holds the runs after it that share its shift.
    let body = '';
    let j = k;
    while (j < runs.length && runs[j].shift === r.shift && (r.shift || runs[j].greek)) {
      const q = runs[j];
      body += q.greek ? math(q) : (/[A-Za-z]/.test(q.text) ? `\\mathrm{${math(q)}}` : math(q));
      j++;
    }
    k = j - 1;
    parts.push({ math: true, text: r.shift ? `${r.shift === 'sup' ? '^' : '_'}{${body}}` : body });
  }
  let out = '';
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (!p.math) { out += p.text; continue; }
    let body = p.text;
    while (k + 1 < parts.length && parts[k + 1].math) body += parts[++k].text;
    out += `$${body}$`;
  }
  return out;
}

/**
 * The same label as plain text, for the page's own lists and for names in
 * the script: Greek letters as letters, a subscript after _ and a
 * superscript after ^.
 *
 * @param {string} text
 * @returns {string}
 */
export function graceToPlain(text) {
  const s = String(text ?? '');
  if (!s.includes('\\') || isMathText(s)) return s;
  return graceRuns(s).map((r) => {
    const body = r.greek ? Array.from(r.text, (ch) => GREEK_LETTERS[GRACE_GREEK[ch]] || ch).join('') : r.text;
    return r.shift === 'sup' ? `^${body}` : r.shift === 'sub' ? `_${body}` : body;
  }).join('');
}

/* ------------------------------------------------------------------ *
 * The figure the page draws, and the script that draws it
 * ------------------------------------------------------------------ */

/**
 * A running mean over `window` points: the mean of each run of that many
 * values in a row, as numpy.convolve(values, np.ones(window) / window,
 * mode='valid') gives it (len(values) - window + 1 values). Empty when the
 * window is below 1 or longer than the data.
 *
 * @param {ArrayLike<number>} values
 * @param {number} window
 * @returns {number[]}
 */
export function runningMean(values, window) {
  const v = Array.from(values || [], Number);
  const n = Math.floor(Number(window));
  if (!(n >= 1) || n > v.length) return [];
  const out = new Array(v.length - n + 1);
  const w = 1 / n;
  if (out.length * n <= 2e7) {
    for (let k = 0; k < out.length; k++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += v[k + j] * w;
      out[k] = s;
    }
    return out;
  }
  // A long run and a wide window: a sliding sum, summed afresh now and then
  // so that rounding cannot build up.
  let s = 0;
  for (let k = 0; k < out.length; k++) {
    if (k % 4096 === 0) { s = 0; for (let j = 0; j < n; j++) s += v[k + j] * w; } else s += (v[k + n - 1] - v[k - 1]) * w;
    out[k] = s;
  }
  return out;
}

/** The running mean's window for `rows` rows: a whole number from 2 up to the rows, or 0 (none). */
export function averageWindow(window, rows) {
  const w = Math.round(Number(window));
  if (!(w >= 2) || !(rows >= 2)) return 0;
  return Math.min(w, rows);
}

/**
 * The colour of each column: the figure's colour cycle (figure.js) in
 * column order, the x column left out, so that a column keeps its colour
 * whichever others are drawn with it.
 *
 * @param {number} colCount
 * @param {number} [xIndex=0]
 * @param {string} [background='#ffffff'] - the figure's background, which picks the cycle
 * @returns {Object<number, string>}
 */
export function xvgColors(colCount, xIndex = 0, background = '#ffffff') {
  const cycle = colorCycle(background || '#ffffff');
  const out = {};
  let k = 0;
  for (let i = 0; i < colCount; i++) {
    if (i === xIndex) continue;
    out[i] = cycle[k++ % cycle.length];
  }
  return out;
}

/**
 * The figure the XVG Visualizer draws, as a description for figure.js: a
 * line for each chosen column against the x column, with the file's labels
 * and legends (Grace escapes as mathematics). Columns on another scale go
 * in a second panel below the first, sharing x (the figure has no second y
 * axis). With a running mean, each column is drawn as its mean over the
 * window, over the data themselves, faded.
 *
 * Every data field says where the script finds it: `source: 'xvg'` and the
 * column number for a column of the file, `source: 'mean'` for its running
 * mean (xvgFigureScript reads these).
 *
 * @param {object} parsed - parseXvg's result
 * @param {object} [view]
 * @param {number} [view.xIndex=0] - the column along x
 * @param {number[]} [view.series] - the columns to draw, in order
 * @param {number[]} [view.lower] - columns to draw in the panel below; used only while
 *   something stays in the panel above
 * @param {boolean} [view.markers=false] - a marker at every point of the data
 * @param {number} [view.average=0] - a running mean over this many points; 0 or 1: none
 * @param {boolean} [view.raw=true] - with a running mean, draw the data under it too
 * @param {Object<number, string>} [view.colors] - a colour for a column, in place of xvgColors'
 * @param {string} [view.background] - the figure's background, for xvgColors' cycle
 * @param {string} [view.filename] - the file's name: the saved figure is <name>_plot
 * @returns {object|null} the description, or null when there is nothing to draw
 */
export function xvgFigure(parsed, view = {}) {
  const p = parsed || {};
  const matrix = Array.isArray(p.matrix) ? p.matrix : [];
  const colCount = Number.isInteger(p.colCount) ? p.colCount : (matrix[0] ? matrix[0].length : 0);
  const xIndex = Number.isInteger(view.xIndex) && view.xIndex >= 0 && view.xIndex < colCount ? view.xIndex : 0;
  const seen = new Set();
  const columns = (Array.isArray(view.series) ? view.series : []).filter((i) => {
    if (!Number.isInteger(i) || i < 0 || i >= colCount || i === xIndex || seen.has(i)) return false;
    seen.add(i);
    return true;
  });
  if (!matrix.length || !columns.length) return null;

  const headers = Array.isArray(p.headers) ? p.headers : [];
  const name = (i) => graceToTex(headers[i] || `Column ${i}`);
  const lowered = new Set(Array.isArray(view.lower) ? view.lower : []);
  const below = columns.filter((i) => lowered.has(i));
  const split = below.length > 0 && below.length < columns.length;
  const above = split ? columns.filter((i) => !lowered.has(i)) : columns;
  const window = averageWindow(view.average, matrix.length);
  const raw = !window || view.raw !== false;
  const colors = { ...xvgColors(colCount, xIndex, view.background), ...(view.colors || {}) };
  const x = extractColumn(matrix, xIndex);
  const xMean = window ? runningMean(x, window) : null;

  const seriesOf = (i) => {
    const out = [];
    const y = extractColumn(matrix, i);
    const color = typeof colors[i] === 'string' && colors[i] ? { color: colors[i] } : {};
    if (raw) {
      out.push({
        id: `col${i}`, kind: 'line', ...color,
        // Under a running mean the data are the background: faded and out of the legend.
        label: window ? `${name(i)} (every point)` : name(i), legend: !window,
        x: { values: x, source: 'xvg', column: xIndex }, y: { values: y, source: 'xvg', column: i },
        lineWidth: window ? 1 : 1.5, alpha: window ? 0.3 : 1,
        marker: view.markers ? 'o' : 'none', size: 3
      });
    }
    if (window) {
      out.push({
        id: `col${i}_mean`, kind: 'line', ...color, label: name(i),
        x: { values: xMean, source: 'mean', column: xIndex }, y: { values: runningMean(y, window), source: 'mean', column: i },
        lineWidth: 1.5
      });
    }
    return out;
  };

  const fileY = p.labels && p.labels.y ? graceToTex(p.labels.y) : '';
  const names = (list) => list.map(name).join(', ');
  const panels = [{
    id: 'main',
    name: split ? 'Top' : '',
    yLabel: fileY || (above.length === 1 || split ? names(above) : ''),
    series: above.flatMap(seriesOf)
  }];
  if (split) panels.push({ id: 'lower', name: 'Bottom', yLabel: names(below), series: below.flatMap(seriesOf) });

  const base = String(view.filename || '').replace(/^.*[/\\]/, '').replace(/\.[^.]*$/, '');
  return {
    title: p.labels && p.labels.title ? graceToTex(p.labels.title) : '',
    xLabel: name(xIndex),
    legend: window ? { title: `Running mean, ${window} points` } : {},
    export: { filename: base ? `${base}_plot` : 'xvg_plot' },
    panels
  };
}

/**
 * The lines of Python that read a file into `data` as parseXvg read it:
 * numpy.loadtxt skipping the '@', '#' and '&' lines (and a header row), or,
 * when the page rejected lines among the numbers, only the lines the page
 * kept (colCount numbers each, a comma at the end of every row dropped).
 *
 * @param {object} parsed - parseXvg's result
 * @param {string} [filename='your_file.xvg']
 * @returns {string[]}
 */
export function xvgReadLines(parsed, filename = 'your_file.xvg') {
  const p = parsed || {};
  const width = Number.isInteger(p.colCount) && p.colCount > 0 ? p.colCount : 0;
  const trailing = Boolean(p.trailingDelimiter) && width > 0;
  const args = [...(p.delimiter ? [`delimiter=${pyStr(p.delimiter)}`] : []), ...(trailing ? [`usecols=range(${width})`] : [])];
  const L = [];
  if (p.strayLines > 0) {
    L.push('def is_record(line):');
    L.push(`    """Whether a line is a row the page plotted: ${width ? `${width} numbers` : 'numbers'}, split at commas or spaces."""`);
    if (trailing) {
      L.push('    line = line.strip()');
      L.push("    if line.endswith(','):  # every row ends with a comma, which is not a value");
      L.push('        line = line[:-1]');
    }
    L.push("    fields = line.split(',') if ',' in line else line.split()");
    L.push('    try:');
    L.push(`        return ${width ? `len(fields) == ${width}` : 'bool(fields)'} and all(np.isfinite(float(v)) for v in fields)`);
    L.push('    except ValueError:');
    L.push('        return False');
    L.push('', '');
    L.push('# Point this at your file. Only the rows the page plotted are read: text, rows of');
    L.push('# another length and the @, # and & lines are left out, as the page left them out.');
    L.push(`with open(${pyStr(filename)}, encoding='utf-8') as fh:`);
    L.push(...pyCall('data = np.loadtxt', ['[line for line in fh if is_record(line)]', ...args, 'ndmin=2'], '    '));
    return L;
  }
  const rows = Number.isInteger(p.skipRows) && p.skipRows > 0 ? p.skipRows : 0;
  const skip = rows === 1 ? 'the first line' : `the first ${rows} lines`;
  L.push(`# Point this at your file. Lines starting with @ or # and the & between data sets${rows ? ',' : ' are'}`);
  L.push(rows ? `# and ${skip} (before the numbers), are skipped.` : '# skipped.');
  L.push(...pyCall('data = np.loadtxt', [pyStr(filename), ...args, ...(rows ? [`skiprows=${rows}`] : []), "comments=['@', '#', '&']", 'ndmin=2']));
  return L;
}

/**
 * The matplotlib script for the XVG Visualizer's figure: it reads the
 * person's file as the page did (or holds the numbers), works out the
 * running means with numpy, and draws the figure with the shared pieces
 * (figureScript), so it saves what the page shows.
 *
 * @param {object} figure - the figure as drawn: xvgFigure's, with the person's style
 * @param {object} parsed - parseXvg's result for the file
 * @param {object} [options]
 * @param {'files'|'embed'} [options.source='files'] - read the file, or hold its numbers
 * @param {string} [options.filename='your_file.xvg'] - the file the script reads
 * @returns {string}
 */
export function xvgFigureScript(figure, parsed, options = {}) {
  const f = normaliseFigure(figure);
  const p = parsed || {};
  const matrix = Array.isArray(p.matrix) ? p.matrix : [];
  const headers = Array.isArray(p.headers) ? p.headers : [];
  const embed = options.source === 'embed';
  const filename = options.filename || 'your_file.xvg';

  // The names figureScript gives the panels, legend handles and markers are
  // kept free, and so are this script's own.
  const taken = new Set(['data', 'running_mean', 'is_record']);
  f.panels.forEach((panel) => {
    taken.add(`ax_${panel.id}`);
    panel.series.forEach((q) => { taken.add(q.id); taken.add(`${q.id}_points`); });
  });
  const columnNames = new Map();
  const nameOf = (c) => {
    if (!columnNames.has(c)) columnNames.set(c, identifier(graceToPlain(headers[c] || `column ${c}`), taken));
    return columnNames.get(c);
  };
  const means = new Map();
  let window = 0;
  const pyRef = (ref, values) => {
    if (!ref || !Number.isInteger(ref.column)) return null;
    if (ref.source === 'xvg') return { py: nameOf(ref.column) };
    if (ref.source !== 'mean') return null;
    if (!window) window = matrix.length - values.length + 1;
    const col = nameOf(ref.column);
    if (!means.has(ref.column)) means.set(ref.column, identifier(`${col}_mean`, taken));
    return { py: means.get(ref.column) };
  };
  const panels = f.panels.map((panel) => ({
    ...panel,
    series: panel.series.map((q) => {
      if (!q.show) return q;
      const refs = { ...(q.refs || {}) };
      for (const k of ['x', 'y']) {
        const r = pyRef(refs[k], q[k] || []);
        if (r) refs[k] = r;
      }
      return { ...q, refs };
    })
  }));

  const L = [];
  const label = (c) => comment(graceToPlain(headers[c] || `column ${c}`));
  if (embed) {
    L.push(`# The columns of ${comment(filename)} the figure draws, as the page read them.`);
    for (const [c, name] of columnNames) {
      L.push(`# Column ${c}: ${label(c)}`);
      L.push(...pyArray(name, extractColumn(matrix, c)));
    }
  } else {
    L.push(...xvgReadLines(p, filename), '');
    for (const [c, name] of columnNames) L.push(`${name} = data[:, ${c}]  # column ${c}: ${label(c)}`);
  }
  if (means.size) {
    L.push('', '');
    L.push('def running_mean(values, n):');
    L.push('    """The mean of every run of n values in a row (len(values) - n + 1 of them)."""');
    L.push("    return np.convolve(values, np.ones(n) / n, mode='valid')");
    L.push('', '');
    L.push(`# A running mean over ${window} points, drawn over the data.`);
    const order = [...means.keys()].sort((a, b) => [...columnNames.keys()].indexOf(a) - [...columnNames.keys()].indexOf(b));
    for (const c of order) L.push(`${means.get(c)} = running_mean(${columnNames.get(c)}, ${window})`);
  }

  const header = [`A plot of ${filename}, from STEMKit's XVG Visualizer (https://stemkit.net/xvg-visualizer.html).`];
  if (!embed) header.push(`It reads ${filename}: keep the file beside the script, or change the path under Data.`);
  return figureScript({ ...f, panels }, { prelude: L, header });
}
